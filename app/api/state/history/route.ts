import { env } from "cloudflare:workers";
import { audit, requireUser } from "@/lib/auth";
import { readJsonObject, RequestBodyTooLargeError } from "@/lib/http";

export const dynamic = "force-dynamic";

const HISTORY_LIMIT = 10;

type RevisionRow = {
  revision: number;
  payload: string;
  updated_at: string;
  updated_by: string;
};

export async function GET(request: Request) {
  const auth = await requireUser(request, ["owner", "admin"]);
  if (auth.response) return auth.response;
  const requestedRevision = new URL(request.url).searchParams.get("revision");
  if (requestedRevision != null) {
    const revision = Number(requestedRevision);
    if (!Number.isInteger(revision) || revision < 1) {
      return Response.json({ error: "Некорректный номер ревизии" }, { status: 400 });
    }
    const row = await env.DB.prepare(
      `SELECT revision, payload, updated_at, updated_by
       FROM warehouse_state_revisions
       WHERE state_key = 'main' AND revision = ?`,
    ).bind(revision).first<RevisionRow>();
    if (!row) return Response.json({ error: "Ревизия не найдена" }, { status: 404 });
    try {
      return Response.json({
        revision: row.revision,
        state: JSON.parse(row.payload),
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      });
    } catch {
      return Response.json({ error: "Архивная ревизия повреждена" }, { status: 500 });
    }
  }
  const result = await env.DB.prepare(
    `SELECT revision, updated_at AS updatedAt, updated_by AS updatedBy,
            length(payload) AS sizeBytes
     FROM warehouse_state_revisions
     WHERE state_key = 'main'
     ORDER BY revision DESC
     LIMIT ?`,
  ).bind(HISTORY_LIMIT).all();
  return Response.json({ revisions: result.results ?? [] });
}

export async function POST(request: Request) {
  const auth = await requireUser(request, ["owner"]);
  if (auth.response || !auth.user) return auth.response;
  let body: Record<string, unknown> | null;
  try {
    body = await readJsonObject(request, 4_096);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json({ error: "Запрос восстановления слишком велик" }, { status: 413 });
    }
    return Response.json({ error: "Некорректный JSON" }, { status: 400 });
  }
  const targetRevision = Number(body?.revision);
  const expectedRevision = Number(body?.expectedRevision);
  if (
    !Number.isInteger(targetRevision) || targetRevision < 1
    || !Number.isInteger(expectedRevision) || expectedRevision < 1
  ) {
    return Response.json({ error: "Укажите архивную и текущую ревизии" }, { status: 400 });
  }
  const [current, archived] = await Promise.all([
    env.DB.prepare(
      "SELECT revision FROM warehouse_full_state WHERE state_key = 'main'",
    ).first<{ revision: number }>(),
    env.DB.prepare(
      `SELECT payload FROM warehouse_state_revisions
       WHERE state_key = 'main' AND revision = ?`,
    ).bind(targetRevision).first<{ payload: string }>(),
  ]);
  if (!current || current.revision !== expectedRevision) {
    return Response.json(
      { error: "Склад уже изменён другим пользователем", conflict: true, currentRevision: current?.revision ?? 0 },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }
  if (!archived) return Response.json({ error: "Архивная ревизия не найдена" }, { status: 404 });
  try {
    const parsed = JSON.parse(archived.payload) as Record<string, unknown>;
    if (
      !parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || !Array.isArray(parsed.items) || !Array.isArray(parsed.posts) || !Array.isArray(parsed.docs)
    ) {
      throw new Error("invalid state");
    }
  } catch {
    return Response.json({ error: "Архивная ревизия повреждена" }, { status: 500 });
  }
  const revision = expectedRevision + 1;
  const updatedAt = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE warehouse_full_state
       SET revision = ?, payload = ?, updated_at = ?, updated_by = ?
       WHERE state_key = 'main' AND revision = ?`,
    ).bind(revision, archived.payload, updatedAt, auth.user.callsign, expectedRevision),
    env.DB.prepare(
      `INSERT OR REPLACE INTO warehouse_state_revisions
         (state_key, revision, payload, updated_at, updated_by)
       SELECT state_key, revision, payload, updated_at, updated_by
       FROM warehouse_full_state
       WHERE state_key = 'main' AND revision = ?`,
    ).bind(revision),
    env.DB.prepare(
      `DELETE FROM warehouse_state_revisions
       WHERE state_key = 'main'
         AND revision NOT IN (
           SELECT revision FROM warehouse_state_revisions
           WHERE state_key = 'main'
           ORDER BY revision DESC
           LIMIT ?
         )`,
    ).bind(HISTORY_LIMIT),
    env.DB.prepare(
      `DELETE FROM warehouse_state_items
       WHERE state_key = 'main'
         AND EXISTS (
           SELECT 1 FROM warehouse_full_state
           WHERE state_key = 'main' AND revision = ?
         )`,
    ).bind(revision),
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
  if (Number(results[0].meta?.changes ?? 0) !== 1) {
    const latest = await env.DB.prepare(
      "SELECT revision FROM warehouse_full_state WHERE state_key = 'main'",
    ).first<{ revision: number }>();
    return Response.json(
      { error: "Склад уже изменён другим пользователем", conflict: true, currentRevision: latest?.revision ?? 0 },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }
  await audit(
    auth.user,
    "state_restored",
    `Архивная ревизия ${targetRevision} восстановлена как ревизия ${revision}`,
  ).catch((error) => console.error("warehouse state restore audit failed", error));
  return Response.json({ revision, restoredFrom: targetRevision, updatedAt });
}
