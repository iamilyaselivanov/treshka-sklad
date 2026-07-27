import type { WarehouseState } from "@/lib/warehouse-state";

const MAX_COLLECTION_ITEMS = 50_000;
export const CURRENT_WAREHOUSE_SCHEMA_VERSION = 4;
const REQUIRED_COLLECTIONS = ["items", "posts", "docs"] as const;
const OPTIONAL_COLLECTIONS = [
  "extIssues",
  "stockTransfers",
  "inventoryActs",
  "auditLog",
  "notifications",
] as const;

export function stateRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validCycleCountDraft(value: unknown) {
  if (value == null) return true;
  const draft = stateRecord(value);
  const counts = stateRecord(draft?.counts);
  const books = stateRecord(draft?.books);
  const actor = stateRecord(draft?.actor);
  const itemIds = Array.isArray(draft?.itemIds)
    ? draft.itemIds.map((itemId) => String(itemId ?? "").trim())
    : [];
  const itemIdSet = new Set(itemIds);
  if (
    !draft || !counts || !books || !actor
    || itemIds.length > MAX_COLLECTION_ITEMS
    || itemIds.some((itemId) => !itemId)
    || itemIdSet.size !== itemIds.length
    || Number(draft.positions) !== itemIds.length
    || Object.keys(books).length !== itemIds.length
    || Object.keys(counts).length > itemIds.length
  ) return false;
  if (!String(draft.id ?? "").trim() || !Number.isFinite(Date.parse(String(draft.startedAt ?? "")))) return false;
  if (!String(actor.id ?? actor.login ?? "").trim() || !String(actor.role ?? "").trim()) return false;
  if (!itemIds.every((itemId) =>
    Number.isSafeInteger(Number(books[itemId])) && Number(books[itemId]) >= 0)) return false;
  return Object.entries(counts).every(([id, quantity]) =>
    itemIdSet.has(id) && Number.isSafeInteger(Number(quantity)) && Number(quantity) >= 0);
}

export function validCycleCountDrafts(value: unknown) {
  if (value == null) return true;
  const drafts = stateRecord(value);
  if (!drafts || Object.keys(drafts).length > 100) return false;
  return Object.entries(drafts).every(([userId, draftValue]) => {
    const actor = stateRecord(stateRecord(draftValue)?.actor);
    return Boolean(
      userId.trim()
      && validCycleCountDraft(draftValue)
      && String(actor?.id ?? "").trim() === userId.trim(),
    );
  });
}

export function prunedCycleCountDrafts(value: unknown) {
  const drafts = stateRecord(value);
  if (!drafts) return {};
  return Object.fromEntries(
    Object.entries(drafts)
      .flatMap(([rawUserId, draftValue]) => {
        const userId = rawUserId.trim();
        const actor = stateRecord(stateRecord(draftValue)?.actor);
        return userId
          && validCycleCountDraft(draftValue)
          && String(actor?.id ?? "").trim() === userId
          ? [[userId, draftValue]]
          : [];
      })
      .slice(0, 100),
  );
}

function structurallySanitizedWarehouseState(
  value: unknown,
  coerceLegacySchema: boolean,
): WarehouseState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = { ...(value as WarehouseState) };
  if (
    !Number.isInteger(state.schemaVersion)
    || Number(state.schemaVersion) < 1
    || Number(state.schemaVersion) > CURRENT_WAREHOUSE_SCHEMA_VERSION
  ) {
    if (!coerceLegacySchema) return null;
    state.schemaVersion = CURRENT_WAREHOUSE_SCHEMA_VERSION;
  }
  for (const key of REQUIRED_COLLECTIONS) {
    if (!Array.isArray(state[key]) || state[key].length > MAX_COLLECTION_ITEMS) return null;
  }
  for (const key of OPTIONAL_COLLECTIONS) {
    if (state[key] != null && (!Array.isArray(state[key]) || state[key].length > MAX_COLLECTION_ITEMS)) return null;
  }
  // Older or manually edited snapshots can contain scalar junk in indexed
  // collections. Keep legitimate records and repair the snapshot before D1
  // extracts object fields from each entry.
  state.items = (state.items as unknown[]).filter(
    (entry) => Boolean(stateRecord(entry)),
  );
  if (Array.isArray(state.inventoryActs)) {
    state.inventoryActs = state.inventoryActs.filter(
      (entry) => Boolean(stateRecord(entry)),
    );
  }
  // Authentication and device-local fields never belong to shared state.
  delete state.accounts;
  delete state.currentAccountId;
  delete state.currentRole;
  delete state.currentUserPost;
  delete state.savedAt;
  return state;
}

export function normalizedWarehouseState(value: unknown): WarehouseState | null {
  const state = structurallySanitizedWarehouseState(value, false);
  if (!state) return null;
  if (!validCycleCountDraft(state.cycleCountDraft) || !validCycleCountDrafts(state.cycleCountDrafts)) {
    return null;
  }
  // Migrate the former single shared slot into a per-account map.
  if (state.cycleCountDraft && !state.cycleCountDrafts) {
    const legacyActor = stateRecord(stateRecord(state.cycleCountDraft)?.actor);
    const legacyUserId = String(legacyActor?.id ?? "").trim();
    state.cycleCountDrafts = legacyUserId ? { [legacyUserId]: state.cycleCountDraft } : {};
  }
  delete state.cycleCountDraft;
  return state;
}

export function sanitizedLegacyWarehouseState(value: unknown): WarehouseState | null {
  const state = structurallySanitizedWarehouseState(value, true);
  if (!state) return null;
  // A damaged draft belonging to one account must not hide valid work owned by
  // other accounts. Restore preparation still replaces archived drafts with
  // drafts from the current live state below.
  const drafts = prunedCycleCountDrafts(state.cycleCountDrafts);
  const legacyDraft = stateRecord(state.cycleCountDraft);
  const legacyActor = stateRecord(legacyDraft?.actor);
  const legacyUserId = String(legacyActor?.id ?? "").trim();
  if (legacyUserId && validCycleCountDraft(legacyDraft) && !drafts[legacyUserId]) {
    drafts[legacyUserId] = legacyDraft;
  }
  state.cycleCountDrafts = drafts;
  delete state.cycleCountDraft;
  return state;
}

export type PreparedWarehouseStateRestore = {
  state: WarehouseState;
  legacySchemaAdjusted: boolean;
  currentStateDamaged: boolean;
  discardedCurrentDrafts: number;
};

export function prepareWarehouseStateRestore(
  archivedValue: unknown,
  currentValue: unknown,
): PreparedWarehouseStateRestore | null {
  const archivedRecord = stateRecord(archivedValue);
  const legacySchemaAdjusted = !Number.isInteger(archivedRecord?.schemaVersion)
    || Number(archivedRecord?.schemaVersion) < 1
    || Number(archivedRecord?.schemaVersion) > CURRENT_WAREHOUSE_SCHEMA_VERSION;
  const state = sanitizedLegacyWarehouseState(archivedValue);
  if (!state) return null;
  const currentState = normalizedWarehouseState(currentValue);
  const sanitizedCurrentState = currentState ?? sanitizedLegacyWarehouseState(currentValue);
  const rawCurrentDrafts = stateRecord(stateRecord(currentValue)?.cycleCountDrafts);
  const recoverableCurrentDrafts = sanitizedCurrentState?.cycleCountDrafts
    ?? prunedCycleCountDrafts(rawCurrentDrafts);
  const discardedCurrentDrafts = rawCurrentDrafts
    ? Math.max(
      0,
      Object.keys(rawCurrentDrafts).length
        - Object.keys(prunedCycleCountDrafts(rawCurrentDrafts)).length,
    )
    : 0;
  state.cycleCountDrafts = recoverableCurrentDrafts;
  return {
    state,
    legacySchemaAdjusted,
    currentStateDamaged: !sanitizedCurrentState,
    discardedCurrentDrafts,
  };
}
