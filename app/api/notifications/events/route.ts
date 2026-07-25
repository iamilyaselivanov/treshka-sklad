import { env } from "cloudflare:workers";
import { audit, requireUser } from "@/lib/auth";
import { isFirebasePushConfigured, sendDevicePush } from "@/lib/fcm";
import { readJsonObject } from "@/lib/http";
import {
  isPushEventType,
  pushActorAllowed,
  pushPresentation,
  pushRecipientQuery,
} from "@/lib/push-events";
import type { PushEventType } from "@/lib/push-events";

export const dynamic = "force-dynamic";

type DeviceRow = {
  userId: string;
  deviceId: string;
  token: string;
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

  const recipientQuery = pushRecipientQuery(type);
  const recipientStatement = env.DB.prepare(recipientQuery.sql);
  const devices = recipientQuery.bindPost
    ? await recipientStatement.bind(post).all<DeviceRow>()
    : await recipientStatement.all<DeviceRow>();
  const rows = devices.results ?? [];
  if (rows.length) {
    await env.DB.batch(rows.map((device) => env.DB.prepare(
      `INSERT OR IGNORE INTO push_deliveries
         (id, event_id, user_id, device_id, status, provider_message_id, error)
       VALUES (?, ?, ?, ?, 'pending', '', '')`,
    ).bind(crypto.randomUUID(), eventId, device.userId, device.deviceId)));
  }

  const pending = await env.DB.prepare(
    `SELECT push_deliveries.user_id AS userId,
            push_deliveries.device_id AS deviceId,
            push_devices.token
     FROM push_deliveries
     JOIN push_devices ON push_devices.device_id = push_deliveries.device_id
     WHERE push_deliveries.event_id = ?
       AND push_deliveries.status IN ('pending', 'failed', 'disabled')`,
  ).bind(eventId).all<DeviceRow>();

  let sent = 0;
  let failed = 0;
  let disabled = 0;
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
    const invalidTokens: string[] = [];
    for (const { device, result } of results) {
      if (result.status === "sent") {
        sent += 1;
        updates.push(env.DB.prepare(
          "UPDATE push_deliveries SET status = 'sent', provider_message_id = ?, error = '', attempted_at = ? WHERE event_id = ? AND device_id = ?",
        ).bind(result.providerMessageId, attemptedAt, eventId, device.deviceId));
      } else {
        if (result.status === "disabled") disabled += 1;
        else failed += 1;
        updates.push(env.DB.prepare(
          "UPDATE push_deliveries SET status = ?, error = ?, attempted_at = ? WHERE event_id = ? AND device_id = ?",
        ).bind(result.status, result.error, attemptedAt, eventId, device.deviceId));
        if (result.status === "failed" && result.unregisterToken) invalidTokens.push(device.token);
      }
    }
    if (updates.length) await env.DB.batch(updates);
    if (invalidTokens.length) {
      await env.DB.batch(invalidTokens.map((token) =>
        env.DB.prepare("DELETE FROM push_devices WHERE token = ?").bind(token)));
    }
  }

  if (inserted.meta.changes > 0) {
    await audit(auth.user, "push_event", `${type} · ${entityNo || post}`);
  }
  const retentionCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM push_deliveries WHERE event_id IN (SELECT id FROM push_events WHERE created_at < ?)",
    ).bind(retentionCutoff),
    env.DB.prepare("DELETE FROM push_events WHERE created_at < ?").bind(retentionCutoff),
    env.DB.prepare(
      `DELETE FROM push_deliveries WHERE event_id IN (
         SELECT id FROM push_events ORDER BY created_at DESC LIMIT -1 OFFSET 10000
       )`,
    ),
    env.DB.prepare(
      "DELETE FROM push_events WHERE id IN (SELECT id FROM push_events ORDER BY created_at DESC LIMIT -1 OFFSET 10000)",
    ),
  ]);
  const responseBody = {
    ok: true,
    pushConfigured: isFirebasePushConfigured(),
    targetDevices: rows.length,
    sent,
    failed,
    disabled,
  };
  if (
    rows.length
    && (!responseBody.pushConfigured || responseBody.failed > 0 || responseBody.disabled > 0)
  ) {
    return Response.json(
      {
        ...responseBody,
        ok: false,
        error: responseBody.pushConfigured
          ? "Не все push доставлены; событие сохранено для автоматического повтора"
          : "Firebase на сервере ещё не настроен; событие сохранено для повтора",
      },
      { status: 503 },
    );
  }
  return Response.json(responseBody);
}
