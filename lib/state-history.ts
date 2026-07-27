export const STATE_HISTORY_RETENTION_DAYS = 30;
export const STATE_HISTORY_SAMPLE_INTERVAL_MS = 5 * 60 * 1_000;
export const STATE_HISTORY_FULL_DETAIL_HOURS = 24;
export const STATE_HISTORY_HOURLY_DAYS = 7;
export const STATE_HISTORY_LIST_LIMIT = 500;
export const STATE_HISTORY_MAX_ROWS = 500;

// Keep every five-minute sample for the most recent day, one sample per hour
// through day seven, and one sample per day through day thirty. The hard row
// cap remains a final guard for bursts of destructive operations, which are
// archived immediately rather than sampled.
export const STATE_HISTORY_PRUNE_SQL = `
  DELETE FROM warehouse_state_revisions
  WHERE state_key = 'main'
    AND revision <> (
      SELECT MAX(revision) FROM warehouse_state_revisions
      WHERE state_key = 'main'
    )
    AND (
      archived_at < ?
      OR (
        archived_at < ?
        AND revision NOT IN (
          SELECT MAX(revision)
          FROM warehouse_state_revisions
          WHERE state_key = 'main'
            AND archived_at >= ? AND archived_at < ?
          GROUP BY substr(archived_at, 1, 13)
          UNION
          SELECT MAX(revision)
          FROM warehouse_state_revisions
          WHERE state_key = 'main'
            AND archived_at >= ? AND archived_at < ?
          GROUP BY substr(archived_at, 1, 10)
        )
      )
    )`;

export const STATE_HISTORY_CAP_SQL = `
  DELETE FROM warehouse_state_revisions
  WHERE state_key = 'main'
    AND revision NOT IN (
      SELECT revision FROM warehouse_state_revisions
      WHERE state_key = 'main'
      ORDER BY archived_at DESC, revision DESC
      LIMIT ?
    )`;

export function stateHistoryRetentionCutoff(now = Date.now()) {
  return new Date(now - STATE_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();
}

export function stateHistorySampleCutoff(now = Date.now()) {
  return new Date(now - STATE_HISTORY_SAMPLE_INTERVAL_MS).toISOString();
}

export function stateHistoryArchiveTimestamp(now = Date.now()) {
  return new Date(now).toISOString();
}

export function stateHistoryFullDetailCutoff(now = Date.now()) {
  return new Date(now - STATE_HISTORY_FULL_DETAIL_HOURS * 60 * 60 * 1_000).toISOString();
}

export function stateHistoryHourlyCutoff(now = Date.now()) {
  return new Date(now - STATE_HISTORY_HOURLY_DAYS * 24 * 60 * 60 * 1_000).toISOString();
}

export function stateHistoryPruneBindings(now = Date.now()) {
  const retention = stateHistoryRetentionCutoff(now);
  const fullDetail = stateHistoryFullDetailCutoff(now);
  const hourly = stateHistoryHourlyCutoff(now);
  return [retention, fullDetail, hourly, fullDetail, retention, hourly] as const;
}
