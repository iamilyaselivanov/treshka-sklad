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

async function ensureSchema() {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS warehouse_full_state (
      state_key TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    )
  `).run();
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  await ensureSchema();
  const row = await env.DB.prepare(
    "SELECT revision, payload, updated_at, updated_by FROM warehouse_full_state WHERE state_key = 'main'",
  ).first<StateRow>();
  if (!row) return Response.json({ revision: 0, state: null }, { headers: { "cache-control": "no-store" } });
  return Response.json(
    {
      revision: row.revision,
      state: JSON.parse(row.payload),
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      sizeBytes: new TextEncoder().encode(row.payload).byteLength,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function PUT(request: Request) {
  const auth = await requireUser(request);
  if (auth.response || !auth.user) return auth.response;
  await ensureSchema();
  const body = (await request.json()) as { state?: unknown };
  if (!body.state || typeof body.state !== "object") {
    return Response.json({ error: "Некорректное состояние склада" }, { status: 400 });
  }
  const payload = JSON.stringify(body.state);
  const sizeBytes = new TextEncoder().encode(payload).byteLength;
  if (sizeBytes > MAX_STATE_BYTES) {
    return Response.json({ error: "Данные склада превышают безопасный размер 4 МБ" }, { status: 413 });
  }
  const previous = await env.DB.prepare(
    "SELECT revision FROM warehouse_full_state WHERE state_key = 'main'",
  ).first<{ revision: number }>();
  const revision = (previous?.revision ?? 0) + 1;
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO warehouse_full_state (state_key, revision, payload, updated_at, updated_by)
    VALUES ('main', ?, ?, ?, ?)
    ON CONFLICT(state_key) DO UPDATE SET
      revision = excluded.revision,
      payload = excluded.payload,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).bind(revision, payload, updatedAt, auth.user.callsign).run();
  if (!previous || revision % 25 === 0) {
    await audit(auth.user, previous ? "state_checkpoint" : "state_created", `${sizeBytes} байт · ревизия ${revision}`);
  }
  return Response.json({ revision, sizeBytes, updatedAt });
}
