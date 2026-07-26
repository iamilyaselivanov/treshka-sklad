export const PUSH_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export async function claimPushMaintenance(
  database: D1Database,
  now = new Date(),
) {
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - PUSH_MAINTENANCE_INTERVAL_MS).toISOString();
  const inserted = await database.prepare(
    "INSERT OR IGNORE INTO push_maintenance_state (id, last_run_at) VALUES (1, ?)",
  ).bind(nowIso).run();
  if (Number(inserted.meta.changes ?? 0) > 0) return true;
  const updated = await database.prepare(
    "UPDATE push_maintenance_state SET last_run_at = ? WHERE id = 1 AND last_run_at <= ?",
  ).bind(nowIso, cutoff).run();
  return Number(updated.meta.changes ?? 0) > 0;
}

export async function runPushMaintenance(database: D1Database) {
  const retentionCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000).toISOString();
  await database.batch([
    database.prepare(
      "DELETE FROM push_deliveries WHERE event_id IN (SELECT id FROM push_events WHERE created_at < ?)",
    ).bind(retentionCutoff),
    database.prepare("DELETE FROM push_events WHERE created_at < ?").bind(retentionCutoff),
    database.prepare(
      `DELETE FROM push_deliveries WHERE event_id IN (
         SELECT id FROM push_events ORDER BY created_at DESC LIMIT -1 OFFSET 10000
       )`,
    ),
    database.prepare(
      "DELETE FROM push_events WHERE id IN (SELECT id FROM push_events ORDER BY created_at DESC LIMIT -1 OFFSET 10000)",
    ),
    database.prepare(
      "DELETE FROM push_deliveries WHERE NOT EXISTS (SELECT 1 FROM push_devices WHERE push_devices.device_id = push_deliveries.device_id)",
    ),
    database.prepare(
      "DELETE FROM push_delivery_attempts WHERE NOT EXISTS (SELECT 1 FROM push_deliveries WHERE push_deliveries.id = push_delivery_attempts.delivery_id)",
    ),
  ]);
}

export async function maybeRunPushMaintenance(
  database: D1Database,
  now = new Date(),
) {
  if (!await claimPushMaintenance(database, now)) return false;
  await runPushMaintenance(database);
  return true;
}
