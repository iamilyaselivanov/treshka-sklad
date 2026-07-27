import { env } from "cloudflare:workers";
import { audit, requireUser } from "@/lib/auth";
import type { SessionUser } from "@/lib/auth";
import { readJsonObject, RequestBodyTooLargeError } from "@/lib/http";
import {
  STATE_HISTORY_CAP_SQL,
  STATE_HISTORY_MAX_ROWS,
  STATE_HISTORY_PRUNE_SQL,
  stateHistoryArchiveTimestamp,
  stateHistoryPruneBindings,
  stateHistorySampleCutoff,
} from "@/lib/state-history";
import {
  projectWarehouseStateForUser,
  warehouseDeletionPolicy,
  warehouseHistoryMutationIssue,
  warehouseItemIds,
} from "@/lib/warehouse-state";
import type { WarehouseState } from "@/lib/warehouse-state";

export const dynamic = "force-dynamic";

type StateRow = {
  revision: number;
  payload: string;
  updated_at: string;
  updated_by: string;
};

type StateMetaRow = Omit<StateRow, "payload">;

const MAX_STATE_BYTES = 1_500_000;
const MAX_STATE_REQUEST_BYTES = 1_550_000;
const MAX_COLLECTION_ITEMS = 50_000;
const MAX_AUDIT_LOG_ITEMS = 2_000;
const MAX_NOTIFICATION_ITEMS = 2_000;
const MAX_INVENTORY_ACT_ITEMS = 5_000;
const REQUIRED_COLLECTIONS = ["items", "posts", "docs"] as const;
const OPTIONAL_COLLECTIONS = [
  "extIssues",
  "stockTransfers",
  "inventoryActs",
  "auditLog",
  "notifications",
] as const;

const SPECIFIC_COLLECTION_LIMITS = {
  auditLog: MAX_AUDIT_LOG_ITEMS,
  notifications: MAX_NOTIFICATION_ITEMS,
  inventoryActs: MAX_INVENTORY_ACT_ITEMS,
} as const;

function collectionLimitError(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as WarehouseState;
  for (const [key, limit] of Object.entries(SPECIFIC_COLLECTION_LIMITS)) {
    const collection = state[key];
    if (Array.isArray(collection) && collection.length > limit) {
      return `Коллекция ${key} превышает безопасный предел ${limit}; данные не были усечены`;
    }
  }
  return null;
}

function stateRecord(value: unknown): Record<string, unknown> | null {
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

function normalizedState(value: unknown): WarehouseState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = { ...(value as WarehouseState) };
  if (!Number.isInteger(state.schemaVersion) || Number(state.schemaVersion) < 1 || Number(state.schemaVersion) > 4) {
    return null;
  }
  for (const key of REQUIRED_COLLECTIONS) {
    if (!Array.isArray(state[key]) || state[key].length > MAX_COLLECTION_ITEMS) return null;
  }
  for (const key of OPTIONAL_COLLECTIONS) {
    if (state[key] != null && (!Array.isArray(state[key]) || state[key].length > MAX_COLLECTION_ITEMS)) return null;
  }
  if (!validCycleCountDraft(state.cycleCountDraft)) return null;
  // Права и аккаунты принадлежат серверной авторизации, а не общему снимку.
  // Их нельзя менять подменённым PUT /api/state.
  delete state.accounts;
  delete state.currentAccountId;
  delete state.currentRole;
  delete state.currentUserPost;
  delete state.savedAt;
  return state;
}

async function inventoryCommitError(
  previous: WarehouseState,
  next: WarehouseState,
  user: SessionUser,
) {
  const previousIds = new Set(
    (Array.isArray(previous.inventoryActs) ? previous.inventoryActs : [])
      .map((value) => String(stateRecord(value)?.id ?? "").trim())
      .filter(Boolean),
  );
  const added = (Array.isArray(next.inventoryActs) ? next.inventoryActs : [])
    .map(stateRecord)
    .filter((value): value is Record<string, unknown> => {
      const id = String(value?.id ?? "").trim();
      return Boolean(value && id && !previousIds.has(id));
    });
  if (!added.length) return null;
  if (!["owner", "admin", "storekeeper"].includes(user.role)) {
    return { status: 403, error: "Проводить инвентаризацию может только владелец, администратор или кладовщик" };
  }
  if (added.length !== 1) {
    return { status: 409, error: "За одну синхронизацию можно завершить только одну инвентаризацию" };
  }
  const header = added[0];
  const id = String(header.id ?? "").trim();
  if (!id || Array.isArray(header.lines)) {
    return { status: 400, error: "Полные строки акта должны храниться в защищённом архиве, а не в снимке склада" };
  }
  const archived = await env.DB.prepare(
    `SELECT payload, actor_user_id AS actorUserId
     FROM inventory_act_archive WHERE id = ?`,
  ).bind(id).first<{ payload: string; actorUserId: string }>();
  if (!archived) {
    return { status: 409, error: "Серверный архив акта инвентаризации не найден" };
  }
  let act: Record<string, unknown> | null = null;
  try {
    act = stateRecord(JSON.parse(archived.payload));
  } catch {
    // handled below
  }
  const lines = Array.isArray(act?.lines) ? act.lines.map(stateRecord) : [];
  const previousItems = new Map(
    (Array.isArray(previous.items) ? previous.items : [])
      .map(stateRecord)
      .filter((value): value is Record<string, unknown> => Boolean(value))
      .map((value) => [String(value.id ?? "").trim(), value]),
  );
  const nextItems = new Map(
    (Array.isArray(next.items) ? next.items : [])
      .map(stateRecord)
      .filter((value): value is Record<string, unknown> => Boolean(value))
      .map((value) => [String(value.id ?? "").trim(), value]),
  );
  if (
    !act || String(act.no ?? "") !== String(header.no ?? "")
    || String(act.scope ?? "") !== String(header.scope ?? "")
    || String(act.date ?? "") !== String(header.date ?? "")
    || String(act.startedAt ?? "") !== String(header.startedAt ?? "")
    || String(act.finishedAt ?? "") !== String(header.finishedAt ?? "")
    || lines.length !== previousItems.size || nextItems.size !== previousItems.size
  ) {
    return { status: 409, error: "Акт не соответствует текущему справочнику склада" };
  }
  const archivedActor = stateRecord(act.actor);
  const headerActor = stateRecord(header.actor);
  const archivedTotals = stateRecord(act.totals);
  const headerTotals = stateRecord(header.totals);
  const archivedDiffs = Array.isArray(act.diffs) ? act.diffs.map(stateRecord) : [];
  const headerDiffs = Array.isArray(header.diffs) ? header.diffs.map(stateRecord) : [];
  if (
    String(archivedActor?.id ?? "") !== archived.actorUserId
    || String(headerActor?.id ?? "") !== archived.actorUserId
    || String(headerActor?.login ?? "") !== String(archivedActor?.login ?? "")
    || String(headerActor?.name ?? "") !== String(archivedActor?.name ?? "")
    || String(headerActor?.role ?? "") !== String(archivedActor?.role ?? "")
    || Number(headerTotals?.positions) !== Number(archivedTotals?.positions)
    || Number(headerTotals?.matched) !== Number(archivedTotals?.matched)
    || Number(headerTotals?.mismatched) !== Number(archivedTotals?.mismatched)
    || Number(headerTotals?.surplus) !== Number(archivedTotals?.surplus)
    || Number(headerTotals?.shortage) !== Number(archivedTotals?.shortage)
    || headerDiffs.length !== archivedDiffs.length
  ) {
    return { status: 409, error: "Заголовок акта не соответствует защищённому серверному архиву" };
  }
  for (const line of lines) {
    const itemId = String(line?.id ?? "").trim();
    const before = previousItems.get(itemId);
    const after = nextItems.get(itemId);
    if (
      !line || !before || !after
      || String(before.name ?? "") !== String(line.name ?? "")
      || String(before.sku ?? "") !== String(line.sku ?? "")
      || String(before.unit ?? "") !== String(line.unit ?? "")
      || Number(before.stock) !== Number(line.book)
      || Number(after.stock) !== Number(line.counted)
      || Number(line.delta) !== Number(line.counted) - Number(line.book)
    ) {
      return { status: 409, error: "Остатки не соответствуют строкам серверного акта инвентаризации" };
    }
  }
  for (let index = 0; index < archivedDiffs.length; index += 1) {
    const archivedDiff = archivedDiffs[index];
    const headerDiff = headerDiffs[index];
    if (
      !archivedDiff || !headerDiff
      || String(headerDiff.id ?? "") !== String(archivedDiff.id ?? "")
      || String(headerDiff.name ?? "") !== String(archivedDiff.name ?? "")
      || String(headerDiff.sku ?? "") !== String(archivedDiff.sku ?? "")
      || String(headerDiff.unit ?? "") !== String(archivedDiff.unit ?? "")
      || Number(headerDiff.book) !== Number(archivedDiff.book)
      || Number(headerDiff.counted) !== Number(archivedDiff.counted)
      || Number(headerDiff.delta) !== Number(archivedDiff.delta)
    ) {
      return { status: 409, error: "Расхождения в заголовке акта подменены" };
    }
  }
  return null;
}

function stateEtag(revision: number, user: SessionUser) {
  const authorizationScope = encodeURIComponent(`${user.id}|${user.role}|${user.assignment}`);
  return `W/"warehouse-main-${revision}-${authorizationScope}"`;
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.response || !auth.user) return auth.response;
  const row = await env.DB.prepare(
    "SELECT revision, payload, updated_at, updated_by FROM warehouse_full_state WHERE state_key = 'main'",
  ).first<StateRow>();
  if (!row) {
    return Response.json(
      { revision: 0, state: null, user: auth.user, partial: auth.user.role === "worker" },
      { headers: { "cache-control": "no-store" } },
    );
  }
  const etag = stateEtag(row.revision, auth.user);
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: { "cache-control": "no-store", etag },
    });
  }
  try {
    const parsedState = JSON.parse(row.payload) as WarehouseState;
    const projectedState = projectWarehouseStateForUser(parsedState, auth.user);
    const projectedPayload = JSON.stringify(projectedState);
    return Response.json(
      {
        revision: row.revision,
        state: projectedState,
        user: auth.user,
        partial: auth.user.role === "worker",
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
        sizeBytes: new TextEncoder().encode(projectedPayload).byteLength,
      },
      { headers: { "cache-control": "no-store", etag } },
    );
  } catch {
    await audit(auth.user, "state_corrupted", `Не удалось прочитать ревизию ${row.revision}`);
    return Response.json(
      { error: "Серверный снимок повреждён. Обратитесь к владельцу, данные не перезаписаны" },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

export async function PUT(request: Request) {
  const auth = await requireUser(request, ["owner", "admin", "storekeeper"]);
  if (auth.response || !auth.user) return auth.response;
  let body: { state?: unknown; expectedRevision?: unknown; partial?: unknown };
  try {
    const parsed = await readJsonObject(request, MAX_STATE_REQUEST_BYTES);
    if (!parsed) {
      return Response.json({ error: "Некорректный JSON" }, { status: 400 });
    }
    body = parsed as typeof body;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json({ error: "Данные склада превышают безопасный размер 1,5 МБ" }, { status: 413 });
    }
    return Response.json({ error: "Некорректный JSON" }, { status: 400 });
  }
  if (body.partial === true) {
    return Response.json(
      {
        error: "Частичный снимок нельзя отправить как полный склад. Сначала загрузите данные для текущей роли",
        terminal: true,
        recover: "server",
      },
      { status: 409 },
    );
  }
  const limitError = collectionLimitError(body.state);
  if (limitError) {
    return Response.json({ error: limitError }, { status: 413 });
  }
  const state = normalizedState(body.state);
  if (!state) {
    return Response.json({ error: "Некорректное состояние склада" }, { status: 400 });
  }
  const expectedRevision = Number(body.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    return Response.json(
      { error: "Требуется номер исходной ревизии. Обновите данные склада" },
      { status: 428 },
    );
  }
  const payload = JSON.stringify(state);
  const sizeBytes = new TextEncoder().encode(payload).byteLength;
  if (sizeBytes > MAX_STATE_BYTES) {
    return Response.json({ error: "Данные склада превышают безопасный размер 1,5 МБ" }, { status: 413 });
  }
  const current = await env.DB.prepare(
    "SELECT revision, updated_at, updated_by FROM warehouse_full_state WHERE state_key = 'main'",
  ).first<StateMetaRow>();
  if (
    (expectedRevision === 0 && current)
    || (expectedRevision > 0 && current?.revision !== expectedRevision)
  ) {
    return Response.json(
      {
        error: "Склад уже изменён другим пользователем",
        conflict: true,
        currentRevision: current?.revision ?? 0,
        updatedAt: current?.updated_at ?? null,
        updatedBy: current?.updated_by ?? null,
      },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }
  const unchanged = current
    ? await env.DB.prepare(
      "SELECT 1 AS matches FROM warehouse_full_state WHERE state_key = 'main' AND revision = ? AND payload = ?",
    ).bind(current.revision, payload).first<{ matches: number }>()
    : null;
  if (current && unchanged) {
    return Response.json(
      {
        revision: current.revision,
        sizeBytes,
        updatedAt: current.updated_at,
        unchanged: true,
      },
      {
        headers: {
          "cache-control": "no-store",
          etag: stateEtag(current.revision, auth.user),
        },
      },
    );
  }
  const nextItemIds = warehouseItemIds(state);
  if (current) {
    const indexedItems = await env.DB.prepare(
      "SELECT item_id AS itemId FROM warehouse_state_items WHERE state_key = 'main'",
    ).all<{ itemId: string }>();
    const previousItemIds = (indexedItems.results ?? []).map((row) => row.itemId);
    const needsDeletionPolicyCheck = previousItemIds.length === 0
      || previousItemIds.some((itemId) => !nextItemIds.has(itemId));
    const needsHistoryPolicyCheck = auth.user.role !== "owner";
    const needsInventoryPolicyCheck = Array.isArray(state.inventoryActs)
      && state.inventoryActs.length > 0;
    if (!needsDeletionPolicyCheck && !needsHistoryPolicyCheck && !needsInventoryPolicyCheck) {
      // Normal writes avoid reading and parsing the potentially 4 MB snapshot.
      // warehouse_state_items is maintained atomically with payload below.
    } else {
      const previousRow = await env.DB.prepare(
        "SELECT payload FROM warehouse_full_state WHERE state_key = 'main' AND revision = ?",
      ).bind(current.revision).first<{ payload: string }>();
      if (!previousRow) {
        return Response.json(
          { error: "Склад уже изменён другим пользователем", conflict: true },
          { status: 409, headers: { "cache-control": "no-store" } },
        );
      }
      let previous: WarehouseState | null = null;
      try {
        previous = normalizedState(JSON.parse(previousRow.payload));
      } catch {
        // Never overwrite a damaged snapshot before an owner can export/recover it.
      }
      if (!previous) {
        return Response.json(
          { error: "Серверный снимок повреждён. Обратитесь к владельцу" },
          { status: 500 },
        );
      }
      const inventoryIssue = await inventoryCommitError(previous, state, auth.user);
      if (inventoryIssue) {
        return Response.json(
          { error: inventoryIssue.error, terminal: true, recover: "server" },
          { status: inventoryIssue.status },
        );
      }
      const policy = warehouseHistoryMutationIssue(previous, state, auth.user.role)
        ?? warehouseDeletionPolicy(previous, state, auth.user.role);
      if (policy) {
        if (
          "code" in policy
          && policy.code === "too_many_new_rows"
          && "auditRowsAdded" in policy
          && "notificationRowsAdded" in policy
        ) {
          await audit(
            auth.user,
            "state_feed_append_rejected",
            `Роль ${auth.user.role} · журнал: ${Number(policy.auditRowsAdded) || 0} · уведомления: ${Number(policy.notificationRowsAdded) || 0}`,
          ).catch((error) => console.error("warehouse feed rejection audit failed", error));
        }
        return Response.json(
          { error: policy.error, terminal: true, recover: "server" },
          { status: policy.status },
        );
      }
    }
  }
  const revision = expectedRevision + 1;
  const updatedAt = new Date().toISOString();
  const stateWrite = expectedRevision === 0
    ? env.DB.prepare(`
        INSERT INTO warehouse_full_state (state_key, revision, payload, updated_at, updated_by)
        VALUES ('main', 1, ?, ?, ?)
        ON CONFLICT(state_key) DO NOTHING
      `).bind(payload, updatedAt, auth.user.callsign)
    : env.DB.prepare(`
        UPDATE warehouse_full_state
        SET revision = ?, payload = ?, updated_at = ?, updated_by = ?
        WHERE state_key = 'main' AND revision = ?
      `).bind(revision, payload, updatedAt, auth.user.callsign, expectedRevision);
  let result;
  try {
    const archivedAt = stateHistoryArchiveTimestamp();
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO warehouse_state_revisions
           (state_key, revision, payload, updated_at, updated_by, size_bytes, archived_at)
         SELECT state_key, revision, payload, updated_at, updated_by, length(payload), ?
         FROM warehouse_full_state
         WHERE state_key = 'main'
           AND NOT EXISTS (
             SELECT 1 FROM warehouse_state_revisions
             WHERE state_key = 'main' AND archived_at >= ?
           )`,
      ).bind(archivedAt, stateHistorySampleCutoff()),
      stateWrite,
      env.DB.prepare(
        `${STATE_HISTORY_PRUNE_SQL}
         AND EXISTS (
           SELECT 1 FROM warehouse_state_revisions
           WHERE state_key = 'main' AND archived_at = ? AND revision = ?
         )`,
      ).bind(...stateHistoryPruneBindings(), archivedAt, expectedRevision),
      env.DB.prepare(
        `${STATE_HISTORY_CAP_SQL}
         AND EXISTS (
           SELECT 1 FROM warehouse_state_revisions
           WHERE state_key = 'main' AND archived_at = ? AND revision = ?
         )`,
      ).bind(STATE_HISTORY_MAX_ROWS, archivedAt, expectedRevision),
      env.DB.prepare(
         `DELETE FROM warehouse_state_items
         WHERE state_key = 'main'
           AND EXISTS (
             SELECT 1 FROM warehouse_full_state
             WHERE state_key = 'main' AND revision = ?
           )
           AND item_id NOT IN (
             SELECT TRIM(CAST(json_extract(value, '$.id') AS TEXT))
             FROM warehouse_full_state,
                  json_each(warehouse_full_state.payload, '$.items')
             WHERE warehouse_full_state.state_key = 'main'
               AND warehouse_full_state.revision = ?
               AND TRIM(CAST(json_extract(value, '$.id') AS TEXT)) <> ''
           )`,
      ).bind(revision, revision),
      env.DB.prepare(
        `INSERT OR IGNORE INTO warehouse_state_items (state_key, item_id)
         SELECT warehouse_full_state.state_key,
                TRIM(CAST(json_extract(value, '$.id') AS TEXT))
         FROM warehouse_full_state,
              json_each(warehouse_full_state.payload, '$.items')
         WHERE warehouse_full_state.state_key = 'main'
           AND warehouse_full_state.revision = ?
           AND TRIM(CAST(json_extract(value, '$.id') AS TEXT)) <> ''`,
      ).bind(revision),
    ]);
    result = results[1];
  } catch (error) {
    console.error("warehouse state write failed", error);
    try {
      await audit(auth.user, "state_write_failed", `${sizeBytes} байт · исходная ревизия ${expectedRevision}`);
    } catch (auditError) {
      console.error("warehouse state failure audit failed", auditError);
    }
    return Response.json(
      { error: "Сервер не смог сохранить снимок. Данные на устройстве не сброшены; повторите позже" },
      { status: 507, headers: { "cache-control": "no-store" } },
    );
  }
  if (Number(result.meta?.changes ?? 0) !== 1) {
    const current = await env.DB.prepare(
      "SELECT revision, updated_at, updated_by FROM warehouse_full_state WHERE state_key = 'main'",
    ).first<{ revision: number; updated_at: string; updated_by: string }>();
    return Response.json(
      {
        error: "Склад уже изменён другим пользователем",
        conflict: true,
        currentRevision: current?.revision ?? 0,
        updatedAt: current?.updated_at ?? null,
        updatedBy: current?.updated_by ?? null,
      },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    await audit(
      auth.user,
      revision === 1 ? "state_created" : "state_updated",
      `${sizeBytes} байт · ревизия ${revision}`,
    );
  } catch (error) {
    // The state transaction has already committed. Returning 500 here makes a
    // correct client retry with a stale revision and manufacture a false
    // conflict. Keep the successful write response authoritative and surface
    // the independent audit-storage failure to platform logs.
    console.error("warehouse state success audit failed", error);
  }
  return Response.json(
    { revision, sizeBytes, updatedAt },
    { headers: { etag: stateEtag(revision, auth.user) } },
  );
}
