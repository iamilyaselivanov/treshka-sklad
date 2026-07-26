import { env } from "cloudflare:workers";
import { audit, requireUser } from "@/lib/auth";
import { warehouseDeletionPolicy, warehouseItemIds } from "@/lib/warehouse-state";
import type { WarehouseState } from "@/lib/warehouse-state";

export const dynamic = "force-dynamic";

type StateRow = {
  revision: number;
  payload: string;
  updated_at: string;
  updated_by: string;
};

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_COLLECTION_ITEMS = 50_000;
const MAX_AUDIT_LOG_ITEMS = 2_000;
const REQUIRED_COLLECTIONS = ["items", "posts", "docs"] as const;
const OPTIONAL_COLLECTIONS = [
  "extIssues",
  "stockTransfers",
  "inventoryActs",
  "auditLog",
  "notifications",
] as const;

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
  // Права и аккаунты принадлежат серверной авторизации, а не общему снимку.
  // Их нельзя менять подменённым PUT /api/state.
  delete state.accounts;
  delete state.currentAccountId;
  delete state.currentRole;
  delete state.currentUserPost;
  delete state.savedAt;
  if (Array.isArray(state.auditLog)) state.auditLog = state.auditLog.slice(0, MAX_AUDIT_LOG_ITEMS);
  return state;
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const row = await env.DB.prepare(
    "SELECT revision, payload, updated_at, updated_by FROM warehouse_full_state WHERE state_key = 'main'",
  ).first<StateRow>();
  if (!row) {
    return Response.json(
      { revision: 0, state: null, user: auth.user },
      { headers: { "cache-control": "no-store" } },
    );
  }
  const etag = `W/"warehouse-main-${row.revision}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: { "cache-control": "no-store", etag },
    });
  }
  try {
    return Response.json(
      {
        revision: row.revision,
        state: JSON.parse(row.payload),
        user: auth.user,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
        sizeBytes: new TextEncoder().encode(row.payload).byteLength,
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
  let body: { state?: unknown; expectedRevision?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Некорректный JSON" }, { status: 400 });
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
    return Response.json({ error: "Данные склада превышают безопасный размер 4 МБ" }, { status: 413 });
  }
  const current = await env.DB.prepare(
    "SELECT revision, payload, updated_at, updated_by FROM warehouse_full_state WHERE state_key = 'main'",
  ).first<StateRow>();
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
  if (current?.payload === payload) {
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
          etag: `W/"warehouse-main-${current.revision}"`,
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
    const needsPolicyCheck = previousItemIds.length === 0
      || previousItemIds.some((itemId) => !nextItemIds.has(itemId));
    if (!needsPolicyCheck) {
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
      const deletionPolicy = warehouseDeletionPolicy(previous, state, auth.user.role);
      if (deletionPolicy) {
        return Response.json(
          { error: deletionPolicy.error, terminal: true, recover: "server" },
          { status: deletionPolicy.status },
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
  const results = await env.DB.batch([
    stateWrite,
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
  const result = results[0];
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
  await audit(
    auth.user,
    revision === 1 ? "state_created" : "state_updated",
    `${sizeBytes} байт · ревизия ${revision}`,
  );
  return Response.json(
    { revision, sizeBytes, updatedAt },
    { headers: { etag: `W/"warehouse-main-${revision}"` } },
  );
}
