import { env } from "cloudflare:workers";
import { audit, requireUser } from "@/lib/auth";
import { readJsonObject } from "@/lib/http";
import { isFirebasePushConfigured } from "@/lib/fcm";
import { runPushMaintenance, shouldRunPushMaintenance } from "@/lib/push-maintenance";

export const dynamic = "force-dynamic";

const deviceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DEVICES_PER_USER = 8;

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth.response || !auth.user) return auth.response;
  const body = await readJsonObject(request);
  if (!body) return Response.json({ error: "Некорректный JSON" }, { status: 400 });

  const deviceId = String(body.deviceId ?? "").trim();
  const token = String(body.token ?? "").trim();
  const platform = String(body.platform ?? "android").trim();
  const appVersion = String(body.appVersion ?? "").trim();
  if (
    !deviceIdPattern.test(deviceId)
    || token.length < 64 || token.length > 4_096
    || platform !== "android"
    || appVersion.length > 40
  ) {
    return Response.json({ error: "Некорректные данные устройства" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - 180 * 24 * 60 * 60 * 1_000).toISOString();
  const existing = await env.DB.prepare(
    "SELECT user_id AS userId, token FROM push_devices WHERE device_id = ?",
  ).bind(deviceId).first<{ userId: string; token: string }>();
  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM push_devices WHERE last_seen_at < ?").bind(staleBefore),
    env.DB.prepare(
      `DELETE FROM push_devices
       WHERE token = ? AND device_id <> ?`,
    ).bind(token, deviceId),
    env.DB.prepare(
      `DELETE FROM push_devices
       WHERE id = (
         SELECT id FROM push_devices
         WHERE user_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM push_devices WHERE device_id = ? AND user_id = ?
           )
           AND (SELECT COUNT(*) FROM push_devices WHERE user_id = ?) >= ?
         ORDER BY last_seen_at ASC, created_at ASC, id ASC
         LIMIT 1
       )`,
    ).bind(auth.user.id, deviceId, auth.user.id, auth.user.id, MAX_DEVICES_PER_USER),
    env.DB.prepare(
      `INSERT INTO push_devices
         (id, user_id, device_id, token, platform, app_version, created_at, updated_at, last_seen_at)
       VALUES (?, ?, ?, ?, 'android', ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         user_id = excluded.user_id,
         token = excluded.token,
         platform = excluded.platform,
         app_version = excluded.app_version,
         updated_at = excluded.updated_at,
         last_seen_at = excluded.last_seen_at`,
    ).bind(
      crypto.randomUUID(),
      auth.user.id,
      deviceId,
      token,
      appVersion,
      now,
      now,
      now,
    ),
  ]);
  const evictedOldest = Number(results[2].meta?.changes ?? 0) === 1;
  if (!existing || existing.userId !== auth.user.id || existing.token !== token) {
    await audit(auth.user, "push_device_registered", `${platform} · ${deviceId.slice(0, 8)}`);
  }
  if (shouldRunPushMaintenance()) await runPushMaintenance(env.DB);
  return Response.json({ ok: true, pushConfigured: isFirebasePushConfigured(), evictedOldest });
}

export async function DELETE(request: Request) {
  const auth = await requireUser(request);
  if (auth.response || !auth.user) return auth.response;
  const body = await readJsonObject(request);
  if (!body) return Response.json({ error: "Некорректный JSON" }, { status: 400 });
  const deviceId = String(body.deviceId ?? "").trim();
  if (!deviceIdPattern.test(deviceId)) {
    return Response.json({ error: "Некорректный идентификатор устройства" }, { status: 400 });
  }
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM push_delivery_attempts
       WHERE delivery_id IN (
         SELECT id FROM push_deliveries
         WHERE device_id = ?
           AND EXISTS (
             SELECT 1 FROM push_devices
             WHERE push_devices.device_id = push_deliveries.device_id
               AND push_devices.user_id = ?
           )
       )`,
    ).bind(deviceId, auth.user.id),
    env.DB.prepare(
      `DELETE FROM push_deliveries
       WHERE device_id = ?
         AND EXISTS (
           SELECT 1 FROM push_devices
           WHERE push_devices.device_id = push_deliveries.device_id
             AND push_devices.user_id = ?
         )`,
    ).bind(deviceId, auth.user.id),
    env.DB.prepare(
      "DELETE FROM push_devices WHERE user_id = ? AND device_id = ?",
    ).bind(auth.user.id, deviceId),
  ]);
  await audit(auth.user, "push_device_unregistered", `android · ${deviceId.slice(0, 8)}`);
  return Response.json({ ok: true });
}
