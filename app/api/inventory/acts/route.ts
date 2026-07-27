import { env } from "cloudflare:workers";
import { audit, requireUser } from "@/lib/auth";
import { readJsonObject, RequestBodyTooLargeError } from "@/lib/http";

export const dynamic = "force-dynamic";

const MAX_ACT_BYTES = 3_500_000;
const MAX_ACT_LINES = 20_000;

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
    return act && typeof act === "object" && !Array.isArray(act) ? act : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const auth = await requireUser(request, ["owner", "admin", "storekeeper"]);
  if (auth.response) return auth.response;
  const id = cleanText(new URL(request.url).searchParams.get("id"), 160);
  if (!id) return Response.json({ error: "Укажите идентификатор акта" }, { status: 400 });
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

  const sequence = await env.DB.prepare(
    `INSERT INTO inventory_act_counters (scope, value) VALUES ('warehouse', 1)
     ON CONFLICT(scope) DO UPDATE SET value = value + 1
     RETURNING value`,
  ).first<{ value: number }>();
  const number = `ИНВ-${String(Number(sequence?.value) || 1).padStart(6, "0")}`;
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
    no: number,
    scope: "warehouse",
    startedAt,
    finishedAt,
    date: new Date(finishedAt).toLocaleString("ru-RU"),
    actor,
    totals,
    lines,
    diffs: lines.filter((line) => line.delta !== 0),
  };
  const payload = JSON.stringify(act);
  const createdAt = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO inventory_act_archive
         (id, number, payload, started_at, finished_at, actor_user_id,
          actor_callsign, actor_role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      number,
      payload,
      startedAt,
      finishedAt,
      auth.user.id,
      auth.user.callsign,
      auth.user.role,
      createdAt,
    ).run();
  } catch (error) {
    console.error("inventory act archive insert failed", error);
    // Two retries with the same id may pass the initial lookup together. The
    // winner has already persisted the act; return that canonical record
    // instead of turning an idempotent retry into a false storage failure.
    const raced = await env.DB.prepare(
      `SELECT id, number, payload, actor_user_id
       FROM inventory_act_archive WHERE id = ?`,
    ).bind(id).first<ArchiveRow>();
    if (raced?.actor_user_id === auth.user.id) {
      const racedAct = parseArchivedAct(raced);
      if (racedAct) return Response.json({ act: racedAct, idempotent: true });
    }
    return Response.json({ error: "Не удалось сохранить акт инвентаризации" }, { status: 507 });
  }
  await audit(
    auth.user,
    "inventory_act_archived",
    `${number} · позиций ${totals.positions} · расхождений ${totals.mismatched}`,
  ).catch((error) => console.error("inventory act audit failed", error));
  return Response.json({ act }, { status: 201 });
}
