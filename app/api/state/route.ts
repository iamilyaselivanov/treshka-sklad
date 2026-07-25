import { env } from "cloudflare:workers";
import { audit, requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

type StateRow = {
  revision: number;
  payload: string;
  updated_at: string;
  updated_by: string;
};

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_COLLECTION_ITEMS = 50_000;
let stateSchemaPromise: Promise<unknown> | null = null;
const REQUIRED_COLLECTIONS = ["items", "posts", "docs"] as const;
const OPTIONAL_COLLECTIONS = [
  "extIssues",
  "stockTransfers",
  "inventoryActs",
  "auditLog",
  "notifications",
] as const;

type WarehouseState = Record<string, unknown>;

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

async function ensureSchema() {
  if (!stateSchemaPromise) {
    stateSchemaPromise = env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS warehouse_full_state (
        state_key TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      )
    `).run().catch((error) => {
      stateSchemaPromise = null;
      throw error;
    });
  }
  await stateSchemaPromise;
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  await ensureSchema();
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
  // Снимок склада перезаписывают только роли, которые ведут учёт.
  // Роль "worker" состояние читает (GET выше), но записывать не может: без
  // этой проверки любой авторизованный пользователь мог отправить пустые
  // items/posts/docs и одной ревизией стереть весь склад — причём незаметно,
  // так как audit() ниже пишется лишь на ревизии 1 и каждой 25-й.
  const auth = await requireUser(request, ["owner", "admin", "storekeeper"]);
  if (auth.response || !auth.user) return auth.response;
  await ensureSchema();
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
  const revision = expectedRevision + 1;
  const updatedAt = new Date().toISOString();
  const result = expectedRevision === 0
    ? await env.DB.prepare(`
        INSERT INTO warehouse_full_state (state_key, revision, payload, updated_at, updated_by)
        VALUES ('main', 1, ?, ?, ?)
        ON CONFLICT(state_key) DO NOTHING
      `).bind(payload, updatedAt, auth.user.callsign).run()
    : await env.DB.prepare(`
        UPDATE warehouse_full_state
        SET revision = ?, payload = ?, updated_at = ?, updated_by = ?
        WHERE state_key = 'main' AND revision = ?
      `).bind(revision, payload, updatedAt, auth.user.callsign, expectedRevision).run();
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
  if (revision === 1 || revision % 25 === 0) {
    await audit(auth.user, revision === 1 ? "state_created" : "state_checkpoint", `${sizeBytes} байт · ревизия ${revision}`);
  }
  return Response.json({ revision, sizeBytes, updatedAt });
}
