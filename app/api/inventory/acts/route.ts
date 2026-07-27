import { env } from "cloudflare:workers";
import { audit, requireUser } from "@/lib/auth";
import { readJsonObject, RequestBodyTooLargeError } from "@/lib/http";

export const dynamic = "force-dynamic";

// D1 limits one string/row to 2 MB. Leave room for JSON normalization,
// metadata columns and future schema fields instead of accepting a request
// that the archive can never persist.
const MAX_ACT_BYTES = 1_800_000;
const MAX_ACT_LINES = 15_000;

type ArchiveRow = {
  id: string;
  number: string;
  payload: string;
  actor_user_id: string;
};

type InventoryLine = {
  id: string;
  name: string;
  sku: string;
  unit: string;
  book: number;
  counted: number;
  delta: number;
};

function cleanText(value: unknown, maximum = 300) {
  return String(value ?? "").trim().slice(0, maximum);
}

function validIso(value: unknown) {
  const text = cleanText(value, 40);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : "";
}

function normalizeLines(value: unknown): InventoryLine[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ACT_LINES) return null;
  const seen = new Set<string>();
  const result: InventoryLine[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const source = raw as Record<string, unknown>;
    const id = cleanText(source.id, 160);
    const name = cleanText(source.name, 500);
    const sku = cleanText(source.sku, 160);
    const unit = cleanText(source.unit, 40);
    const book = Number(source.book);
    const counted = Number(source.counted);
    if (
      !id || !name || !sku || !unit || seen.has(id)
      || !Number.isSafeInteger(book) || book < 0
      || !Number.isSafeInteger(counted) || counted < 0
    ) return null;
    seen.add(id);
    result.push({ id, name, sku, unit, book, counted, delta: counted - book });
  }
  return result;
}

function parseArchivedAct(row: ArchiveRow) {
  try {
    const act = JSON.parse(row.payload);
    if (!act || typeof act !== "object" || Array.isArray(act)) return null;
    if (!Array.isArray(act.diffs) && Array.isArray(act.lines)) {
      act.diffs = act.lines.filter((line: InventoryLine) => Number(line?.delta) !== 0);
    }
    return act;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const auth = await requireUser(request, ["owner", "admin", "storekeeper"]);
  if (auth.response) return auth.response;
  const id = cleanText(new URL(request.url).searchParams.get("id"), 160);
  if (!id) {
    // A device can successfully archive an act and then lose connectivity
    // before its compact header and stock corrections reach /api/state.
    // Expose one such act at a time so a client can safely replay it when its
    // recorded book quantities still match the current warehouse snapshot.
    const result = await env.DB.prepare(
      `SELECT archive.id, archive.number, archive.payload, archive.actor_user_id
       FROM inventory_act_archive AS archive
       LEFT JOIN warehouse_state_inventory_acts AS state_act
         ON state_act.state_key = 'main'
        AND state_act.act_id = archive.id
       WHERE state_act.act_id IS NULL
         AND (? IN ('owner', 'admin') OR archive.actor_user_id = ?)
       ORDER BY archive.finished_at ASC, archive.number ASC
       LIMIT 1`,
    ).bind(auth.user?.role ?? "", auth.user?.id ?? "").all<ArchiveRow>();
    const pending = (result.results ?? [])
      .map(parseArchivedAct)
      .filter((act): act is Record<string, unknown> => Boolean(act));
    return Response.json({ pending }, { headers: { "cache-control": "private, no-store" } });
  }
  const row = await env.DB.prepare(
    `SELECT id, number, payload, actor_user_id
     FROM inventory_act_archive WHERE id = ?`,
  ).bind(id).first<ArchiveRow>();
  if (!row) return Response.json({ error: "Акт инвентаризации не найден" }, { status: 404 });
  const act = parseArchivedAct(row);
  if (!act) return Response.json({ error: "Архив акта повреждён" }, { status: 500 });
  return Response.json({ act }, { headers: { "cache-control": "private, no-store" } });
}

export async function POST(request: Request) {
  const auth = await requireUser(request, ["owner", "admin", "storekeeper"]);
  if (auth.response || !auth.user) return auth.response;
  let body: Record<string, unknown> | null;
  try {
    body = await readJsonObject(request, MAX_ACT_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json({ error: "Акт инвентаризации слишком велик" }, { status: 413 });
    }
    return Response.json({ error: "Некорректный JSON" }, { status: 400 });
  }
  const id = cleanText(body?.id, 160);
  const startedAt = validIso(body?.startedAt);
  const finishedAt = validIso(body?.finishedAt);
  const lines = normalizeLines(body?.lines);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(id) || !startedAt || !finishedAt || !lines) {
    return Response.json({ error: "Некорректные данные акта инвентаризации" }, { status: 400 });
  }
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    return Response.json({ error: "Время окончания не может быть раньше начала" }, { status: 400 });
  }

  const existing = await env.DB.prepare(
    `SELECT id, number, payload, actor_user_id
     FROM inventory_act_archive WHERE id = ?`,
  ).bind(id).first<ArchiveRow>();
  if (existing) {
    const act = parseArchivedAct(existing);
    if (!act) return Response.json({ error: "Архив акта повреждён" }, { status: 500 });
    if (existing.actor_user_id !== auth.user.id) {
      return Response.json({ error: "Идентификатор акта уже занят" }, { status: 409 });
    }
    return Response.json({ act, idempotent: true });
  }

  const totals = {
    positions: lines.length,
    matched: lines.filter((line) => line.delta === 0).length,
    mismatched: lines.filter((line) => line.delta !== 0).length,
    surplus: lines.filter((line) => line.delta > 0).reduce((sum, line) => sum + line.delta, 0),
    shortage: lines.filter((line) => line.delta < 0).reduce((sum, line) => sum + Math.abs(line.delta), 0),
    deltaSum: lines.reduce((sum, line) => sum + line.delta, 0),
  };
  const actor = {
    id: auth.user.id,
    login: auth.user.login,
    name: auth.user.callsign,
    role: auth.user.role,
  };
  const act = {
    id,
    no: "",
    scope: "warehouse",
    startedAt,
    finishedAt,
    date: new Date(finishedAt).toLocaleString("ru-RU"),
    actor,
    totals,
    lines,
  };
  const payload = JSON.stringify(act);
  if (new TextEncoder().encode(payload).byteLength > MAX_ACT_BYTES) {
    return Response.json(
      { error: "Акт инвентаризации превышает безопасный размер архива" },
      { status: 413 },
    );
  }
  const createdAt = new Date().toISOString();
  let inserted: ArchiveRow | null = null;
  for (let attempt = 0; attempt < 2 && !inserted; attempt += 1) {
    try {
      // Number derivation and row insertion are one SQLite statement. A failed
      // INSERT consumes nothing, while the unique number index serializes two
      // concurrent writers; a rare collision simply retries the statement.
      inserted = await env.DB.prepare(
        `INSERT INTO inventory_act_archive
           (id, number, payload, started_at, finished_at, actor_user_id,
            actor_callsign, actor_role, created_at)
         SELECT ?, candidate.number, json_set(?, '$.no', candidate.number),
                ?, ?, ?, ?, ?, ?
         FROM (
           SELECT 'ИНВ-' || printf(
             '%06d',
             COALESCE(MAX(
               CASE WHEN number GLOB 'ИНВ-[0-9]*'
                 THEN CAST(substr(number, 5) AS INTEGER)
               END
             ), 0) + 1
           ) AS number
           FROM inventory_act_archive
         ) AS candidate
         RETURNING id, number, payload, actor_user_id`,
      ).bind(
        id,
        payload,
        startedAt,
        finishedAt,
        auth.user.id,
        auth.user.callsign,
        auth.user.role,
        createdAt,
      ).first<ArchiveRow>();
    } catch (error) {
      console.error("inventory act archive insert attempt failed", error);
      const raced = await env.DB.prepare(
        `SELECT id, number, payload, actor_user_id
         FROM inventory_act_archive WHERE id = ?`,
      ).bind(id).first<ArchiveRow>();
      if (raced?.actor_user_id === auth.user.id) {
        const racedAct = parseArchivedAct(raced);
        if (racedAct) return Response.json({ act: racedAct, idempotent: true });
      }
    }
  }
  const archivedAct = inserted ? parseArchivedAct(inserted) : null;
  if (!inserted || !archivedAct) {
    return Response.json({ error: "Не удалось сохранить акт инвентаризации" }, { status: 507 });
  }
  await audit(
    auth.user,
    "inventory_act_archived",
    `${inserted.number} · позиций ${totals.positions} · расхождений ${totals.mismatched}`,
  ).catch((error) => console.error("inventory act audit failed", error));
  return Response.json({ act: archivedAct }, { status: 201 });
}
