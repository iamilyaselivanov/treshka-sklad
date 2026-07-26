export const STATE_HISTORY_RETENTION_DAYS = 30;
export const STATE_HISTORY_SAMPLE_INTERVAL_MS = 5 * 60 * 1_000;
export const STATE_HISTORY_LIST_LIMIT = 500;

export function stateHistoryRetentionCutoff(now = Date.now()) {
  return new Date(now - STATE_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();
}

export function stateHistorySampleCutoff(now = Date.now()) {
  return new Date(now - STATE_HISTORY_SAMPLE_INTERVAL_MS).toISOString();
}
