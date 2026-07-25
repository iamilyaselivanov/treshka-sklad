export const PUSH_MAINTENANCE_SAMPLE_RATE = 64;

export function shouldRunPushMaintenance(sample?: number) {
  const value = sample ?? crypto.getRandomValues(new Uint32Array(1))[0];
  return value % PUSH_MAINTENANCE_SAMPLE_RATE === 0;
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
