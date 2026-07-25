import { env } from "cloudflare:workers";
import { audit, requireUser, Role } from "@/lib/auth";
import { isFirebasePushConfigured, sendDevicePush } from "@/lib/fcm";
import { readJsonObject } from "@/lib/http";

export const dynamic = "force-dynamic";

type EventType =
  | "post_stock_issued"
  | "defect_act_created"
  | "work_act_created"
  | "storekeeper_post_issue_completed"
  | "storekeeper_warehouse_return_accepted";

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

const eventTypes = new Set<EventType>([
  "post_stock_issued",
  "defect_act_created",
  "work_act_created",
  "storekeeper_post_issue_completed",
  "storekeeper_warehouse_return_accepted",
]);

const actorRoles: Record<EventType, Role[]> = {
  post_stock_issued: ["owner", "admin", "storekeeper"],
  defect_act_created: ["owner", "admin", "storekeeper", "worker"],
  work_act_created: ["owner", "admin", "storekeeper", "worker"],
  storekeeper_post_issue_completed: ["storekeeper"],
  storekeeper_warehouse_return_accepted: ["storekeeper"],
};

function presentation(type: EventType, post: string, entityNo: string, summary: string) {
  const suffix = [entityNo, post && `пост ${post}`].filter(Boolean).join(" · ");
  switch (type) {
    case "post_stock_issued":
      return { title: "Товар выдан на ваш пост", body: summary || suffix };
    case "defect_act_created":
      return { title: "Создан акт дефектовки", body: suffix };
    case "work_act_created":
      return { title: "Создан акт выполненных работ", body: suffix };
    case "storekeeper_post_issue_completed":
      return { title: "Кладовщик выдал товар на пост", body: summary || suffix };
    case "storekeeper_warehouse_return_accepted":
      return { title: "Кладовщик принял товар на склад", body: summary || suffix };
  }
}

function recipientSql(type: EventType) {
  if (type === "post_stock_issued") {
    return `SELECT push_devices.user_id AS userId, push_devices.device_id AS deviceId, push_devices.token
            FROM push_devices
            JOIN users ON users.id = push_devices.user_id
            WHERE users.status = 'active' AND users.assignment = ?`;
  }
  if (type === "defect_act_created" || type === "work_act_created") {
    return `SELECT push_devices.user_id AS userId, push_devices.device_id AS deviceId, push_devices.token
            FROM push_devices
            JOIN users ON users.id = push_devices.user_id
            WHERE users.status = 'active' AND users.role IN ('owner', 'admin', 'storekeeper')`;
  }
  return `SELECT push_devices.user_id AS userId, push_devices.device_id AS deviceId, push_devices.token
          FROM push_devices
          JOIN users ON users.id = push_devices.user_id
          WHERE users.status = 'active' AND users.role IN ('owner', 'admin')`;
}

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth.response || !auth.user) return auth.response;
  const raw = await readJsonObject(request);
  if (!raw) return Response.json({ error: "Некорректный JSON" }, { status: 400 });

  const eventId = String(raw.eventId ?? "").trim();
  const type = String(raw.type ?? "") as EventType;
  const post = String(raw.post ?? "").trim();
  const entityNo = String(raw.entityNo ?? "").trim();
  const summary = String(raw.summary ?? "").trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId)
    || !eventTypes.has(type)
    || post.length < 1 || post.length > 160
    || entityNo.length > 120
    || summary.length > 500
  ) {
    return Response.json({ error: "Некорректное событие уведомления" }, { status: 400 });
  }
  if (!actorRoles[type].includes(auth.user.role)) {
    return Response.json({ error: "Недостаточно прав для этого события" }, { status: 403 });
  }

  const { title, body } = presentation(type, post, entityNo, summary);
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

  const devices = type === "post_stock_issued"
    ? await env.DB.prepare(recipientSql(type)).bind(post).all<DeviceRow>()
    : await env.DB.prepare(recipientSql(type)).all<DeviceRow>();
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
  for (const device of pending.results ?? []) {
    const result = await sendDevicePush(device.token, {
      title,
      body,
      eventId,
      eventType: type,
      post,
      entityNo,
    });
    const attemptedAt = new Date().toISOString();
    if (result.status === "sent") {
      sent += 1;
      await env.DB.prepare(
        "UPDATE push_deliveries SET status = 'sent', provider_message_id = ?, error = '', attempted_at = ? WHERE event_id = ? AND device_id = ?",
      ).bind(result.providerMessageId, attemptedAt, eventId, device.deviceId).run();
    } else {
      if (result.status === "disabled") disabled += 1;
      else failed += 1;
      await env.DB.prepare(
        "UPDATE push_deliveries SET status = ?, error = ?, attempted_at = ? WHERE event_id = ? AND device_id = ?",
      ).bind(result.status, result.error, attemptedAt, eventId, device.deviceId).run();
      if (result.status === "failed" && result.unregisterToken) {
        await env.DB.prepare("DELETE FROM push_devices WHERE token = ?").bind(device.token).run();
      }
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
  if (rows.length && !responseBody.pushConfigured) {
    return Response.json(
      { ...responseBody, ok: false, error: "Firebase на сервере ещё не настроен; событие сохранено для повтора" },
      { status: 503 },
    );
  }
  return Response.json(responseBody);
}
