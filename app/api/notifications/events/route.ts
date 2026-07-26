import { env } from "cloudflare:workers";
import { audit, requireUser } from "@/lib/auth";
import { isFirebasePushConfigured, sendDevicePush } from "@/lib/fcm";
import { readJsonObject } from "@/lib/http";
import {
  collectPushRecipients,
  excludePreviouslyNotifiedDevices,
  isPushEventType,
  pushActorAllowed,
  pushPresentation,
  pushRecipientQuery,
} from "@/lib/push-events";
import { maybeRunPushMaintenance } from "@/lib/push-maintenance";
import type { PushEventType } from "@/lib/push-events";

export const dynamic = "force-dynamic";

type DeviceRow = {
  userId: string;
  deviceId: string;
  token: string;
  assignment?: string;
};

type DeliveryDeviceRow = DeviceRow & {
  attempts: number;
  deliveryId: string;
};

type ExistingEventRow = {
  actorUserId: string;
  eventType: string;
  post: string;
  entityNo: string;
  summary: string;
};

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth.response || !auth.user) return auth.response;
  const raw = await readJsonObject(request);
  if (!raw) return Response.json({ error: "Некорректный JSON" }, { status: 400 });

  const eventId = String(raw.eventId ?? "").trim();
  const rawType = String(raw.type ?? "");
  const post = String(raw.post ?? "").trim();
  const entityNo = String(raw.entityNo ?? "").trim();
  const summary = String(raw.summary ?? "").trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId)
    || !isPushEventType(rawType)
    || post.length < 1 || post.length > 160
    || entityNo.length > 120
    || summary.length > 500
  ) {
    return Response.json({ error: "Некорректное событие уведомления" }, { status: 400 });
  }
  const type = rawType as PushEventType;
  if (!pushActorAllowed(type, auth.user.role)) {
    return Response.json({ error: "Недостаточно прав для этого события" }, { status: 403 });
  }

  const { title, body } = pushPresentation(type, post, entityNo, summary);
  const now = new Date().toISOString();
  const existing = await env.DB.prepare(
    `SELECT actor_user_id AS actorUserId, event_type AS eventType, post, entity_no AS entityNo, summary
     FROM push_events WHERE id = ?`,
  ).bind(eventId).first<ExistingEventRow>();
  if (existing && (
    existing.actorUserId !== auth.user.id
    || existing.eventType !== type
    || existing.post !== post
    || existing.entityNo !== entityNo
    || existing.summary !== summary
  )) {
    return Response.json({ error: "Идентификатор события уже использован" }, { status: 409 });
  }
  if (!existing) {
    const minuteAgo = new Date(Date.now() - 60_000).toISOString();
    const recent = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM push_events WHERE actor_user_id = ? AND created_at >= ?",
    ).bind(auth.user.id, minuteAgo).first<{ count: number }>();
    const limit = auth.user.role === "worker" ? 20 : 120;
    if (Number(recent?.count ?? 0) >= limit) {
      return Response.json({ error: "Слишком много событий. Повторите позже" }, { status: 429 });
    }
  }
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO push_events
       (id, actor_user_id, event_type, post, entity_no, summary, title, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(eventId, auth.user.id, type, post, entityNo, summary, title, body, now).run();

  const recipientQuery = pushRecipientQuery(type, post, auth.user.id);
  let rows = await collectPushRecipients<DeviceRow>(
    async (limit, offset) => {
      const devices = await env.DB.prepare(recipientQuery.sql)
        .bind(...recipientQuery.bindings, limit, offset)
        .all<DeviceRow>();
      return devices.results ?? [];
    },
  );
  if (type === "storekeeper_post_issue_completed" && entityNo) {
    const prior = await env.DB.prepare(
      `SELECT DISTINCT push_deliveries.device_id AS deviceId
       FROM push_deliveries
       JOIN push_events ON push_events.id = push_deliveries.event_id
       WHERE push_events.actor_user_id = ?
         AND push_events.entity_no = ?
         AND push_events.event_type = 'post_stock_issued'`,
    ).bind(auth.user.id, entityNo).all<{ deviceId: string }>();
    rows = excludePreviouslyNotifiedDevices(
      rows,
      (prior.results ?? []).map((entry) => entry.deviceId),
    );
  }
  if (rows.length) {
    await env.DB.batch(rows.map((device) => env.DB.prepare(
      `INSERT OR IGNORE INTO push_deliveries
         (id, event_id, user_id, device_id, status, provider_message_id, error)
       VALUES (?, ?, ?, ?, 'pending', '', '')`,
    ).bind(crypto.randomUUID(), eventId, device.userId, device.deviceId)));
    await env.DB.batch(rows.map((device) => env.DB.prepare(
      `INSERT OR IGNORE INTO push_delivery_attempts (delivery_id, attempts)
       SELECT id, 0 FROM push_deliveries WHERE event_id = ? AND device_id = ?`,
    ).bind(eventId, device.deviceId)));
  }
  // "disabled" means this deployment has no Firebase credentials. It is a
  // terminal delivery state, not a retryable provider failure.
  await env.DB.prepare(
    "UPDATE push_deliveries SET status = 'dead' WHERE event_id = ? AND status = 'disabled'",
  ).bind(eventId).run();

  const pending = await env.DB.prepare(
    `SELECT push_deliveries.user_id AS userId,
             push_deliveries.device_id AS deviceId,
             push_deliveries.id AS deliveryId,
             push_devices.token,
             COALESCE(push_delivery_attempts.attempts, 0) AS attempts
     FROM push_deliveries
     JOIN push_devices ON push_devices.device_id = push_deliveries.device_id
     LEFT JOIN push_delivery_attempts ON push_delivery_attempts.delivery_id = push_deliveries.id
     WHERE push_deliveries.event_id = ?
       AND push_deliveries.status IN ('pending', 'failed')`,
  ).bind(eventId).all<DeliveryDeviceRow>();

  const MAX_DELIVERY_ATTEMPTS = 8;
  let sent = 0;
  let failed = 0;
  let disabled = 0;
  let terminal = 0;
  const pendingDevices = pending.results ?? [];
  for (let offset = 0; offset < pendingDevices.length; offset += 8) {
    const batch = pendingDevices.slice(offset, offset + 8);
    const results = await Promise.all(batch.map(async (device) => ({
      device,
      result: await sendDevicePush(device.token, {
        title,
        body,
        eventId,
        eventType: type,
        post,
        entityNo,
      }),
    })));
    const attemptedAt = new Date().toISOString();
    const updates: D1PreparedStatement[] = [];
    const invalidDeviceIds: string[] = [];
    for (const { device, result } of results) {
      if (result.status === "sent") {
        sent += 1;
        updates.push(env.DB.prepare(
          "UPDATE push_deliveries SET status = 'sent', provider_message_id = ?, error = '', attempted_at = ? WHERE event_id = ? AND device_id = ?",
        ).bind(result.providerMessageId, attemptedAt, eventId, device.deviceId));
      } else {
        const attempts = Number(device.attempts ?? 0) + 1;
        const terminalFailure = result.status === "disabled"
          || (result.status === "failed"
            && (result.unregisterToken || attempts >= MAX_DELIVERY_ATTEMPTS));
        if (terminalFailure) terminal += 1;
        if (result.status === "disabled") disabled += 1;
        else if (!terminalFailure) failed += 1;
        updates.push(env.DB.prepare(
          "UPDATE push_deliveries SET status = ?, error = ?, attempted_at = ? WHERE event_id = ? AND device_id = ?",
        ).bind(terminalFailure ? "dead" : result.status, result.error, attemptedAt, eventId, device.deviceId));
        if (result.status === "failed" && result.unregisterToken) invalidDeviceIds.push(device.deviceId);
      }
      updates.push(env.DB.prepare(
        `INSERT INTO push_delivery_attempts (delivery_id, attempts)
         VALUES (?, ?)
         ON CONFLICT(delivery_id) DO UPDATE SET attempts = excluded.attempts`,
      ).bind(device.deliveryId, Number(device.attempts ?? 0) + 1));
    }
    if (updates.length) await env.DB.batch(updates);
    if (invalidDeviceIds.length) {
      await env.DB.batch(invalidDeviceIds.flatMap((deviceId) => [
        env.DB.prepare(
          "DELETE FROM push_delivery_attempts WHERE delivery_id IN (SELECT id FROM push_deliveries WHERE device_id = ?)",
        ).bind(deviceId),
        env.DB.prepare("DELETE FROM push_deliveries WHERE device_id = ?").bind(deviceId),
        env.DB.prepare("DELETE FROM push_devices WHERE device_id = ?").bind(deviceId),
      ]));
    }
  }

  if (inserted.meta.changes > 0) {
    await audit(auth.user, "push_event", `${type} · ${entityNo || post}`);
  }
  await maybeRunPushMaintenance(env.DB);
  const responseBody = {
    ok: true,
    pushConfigured: isFirebasePushConfigured(),
    targetDevices: rows.length,
    sent,
    failed,
    disabled,
    terminal,
  };
  if (
    rows.length
    && responseBody.failed > 0
  ) {
    return Response.json(
      {
        ...responseBody,
        ok: false,
        error: "Не все push доставлены; событие сохранено для автоматического повтора",
      },
      { status: 503 },
    );
  }
  return Response.json(responseBody);
}
