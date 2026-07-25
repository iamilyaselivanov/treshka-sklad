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

type StateMetadataRow = Omit<StateRow, "payload"> & {
  item_ids: string;
};

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_COLLECTION_ITEMS = 50_000;
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
      { headers: { "cache-control": "no-store" } },
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
  const current = await env.DB.prepare(
    "SELECT revision, item_ids, updated_at, updated_by FROM warehouse_full_state WHERE state_key = 'main'",
  ).first<StateMetadataRow>();
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
  const nextItemIds = warehouseItemIds(state);
  const serializedItemIds = JSON.stringify([...nextItemIds].sort());
  if (current) {
    let previousItemIds: string[] | null = null;
    try {
      const parsed = JSON.parse(current.item_ids) as unknown;
      if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
        previousItemIds = parsed;
      }
    } catch {
      // A malformed index is rebuilt from the authoritative payload below.
    }
    const needsPolicyCheck = !previousItemIds
      || previousItemIds.some((itemId) => !nextItemIds.has(itemId));
    if (!needsPolicyCheck) {
      // Normal writes avoid reading and parsing the potentially 4 MB snapshot.
      // item_ids is maintained atomically with payload below.
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
  const payload = JSON.stringify(state);
  const sizeBytes = new TextEncoder().encode(payload).byteLength;
  if (sizeBytes > MAX_STATE_BYTES) {
    return Response.json({ error: "Данные склада превышают безопасный размер 4 МБ" }, { status: 413 });
  }
  const revision = expectedRevision + 1;
  const updatedAt = new Date().toISOString();
  const result = expectedRevision === 0
    ? await env.DB.prepare(`
        INSERT INTO warehouse_full_state (state_key, revision, payload, item_ids, updated_at, updated_by)
        VALUES ('main', 1, ?, ?, ?, ?)
        ON CONFLICT(state_key) DO NOTHING
      `).bind(payload, serializedItemIds, updatedAt, auth.user.callsign).run()
    : await env.DB.prepare(`
        UPDATE warehouse_full_state
        SET revision = ?, payload = ?, item_ids = ?, updated_at = ?, updated_by = ?
        WHERE state_key = 'main' AND revision = ?
      `).bind(revision, payload, serializedItemIds, updatedAt, auth.user.callsign, expectedRevision).run();
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
  return Response.json({ revision, sizeBytes, updatedAt });
}
