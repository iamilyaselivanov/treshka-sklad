import { env } from "cloudflare:workers";
import { audit, requireUser } from "@/lib/auth";
import { readJsonObject, RequestBodyTooLargeError } from "@/lib/http";
import {
  STATE_HISTORY_CAP_SQL,
  STATE_HISTORY_FULL_DETAIL_HOURS,
  STATE_HISTORY_HOURLY_DAYS,
  STATE_HISTORY_LIST_LIMIT,
  STATE_HISTORY_MAX_ROWS,
  STATE_HISTORY_PRUNE_SQL,
  STATE_HISTORY_RETENTION_DAYS,
  stateHistoryArchiveTimestamp,
  stateHistoryPruneBindings,
} from "@/lib/state-history";
import { projectWarehouseStateForUser } from "@/lib/warehouse-state";
import {
  prepareWarehouseStateRestore,
  sanitizedLegacyWarehouseState,
} from "@/lib/warehouse-state-normalization";

export const dynamic = "force-dynamic";

type RevisionRow = {
  revision: number;
  payload: string;
  updated_at: string;
  updated_by: string;
  size_bytes: number;
  archived_at: string;
  pinned: number;
  reason: string;
};

export async function GET(request: Request) {
  const auth = await requireUser(request, ["owner", "admin"]);
  if (auth.response) return auth.response;
  if (!auth.user) {
    return Response.json({ error: "Требуется авторизация" }, { status: 401 });
  }
  const requestedRevision = new URL(request.url).searchParams.get("revision");
  if (requestedRevision != null) {
    const revision = Number(requestedRevision);
    if (!Number.isInteger(revision) || revision < 1) {
      return Response.json({ error: "Некорректный номер ревизии" }, { status: 400 });
    }
    const row = await env.DB.prepare(
      `SELECT revision, payload, updated_at, updated_by, size_bytes, archived_at, pinned, reason
       FROM warehouse_state_revisions
       WHERE state_key = 'main' AND revision = ?`,
    ).bind(revision).first<RevisionRow>();
    if (!row) return Response.json({ error: "Ревизия не найдена" }, { status: 404 });
    try {
      const sanitizedState = sanitizedLegacyWarehouseState(JSON.parse(row.payload));
      if (!sanitizedState) throw new Error("invalid state");
      const projectedState = projectWarehouseStateForUser(
        sanitizedState,
        auth.user,
      );
      return Response.json({
        revision: row.revision,
        state: projectedState,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
        sizeBytes: row.size_bytes,
        archivedAt: row.archived_at,
        pinned: Boolean(row.pinned),
        reason: row.reason,
      });
    } catch {
      return Response.json({ error: "Архивная ревизия повреждена" }, { status: 500 });
    }
  }
  const [result, oldest, current] = await Promise.all([
    env.DB.prepare(
      `SELECT revision, updated_at AS updatedAt, updated_by AS updatedBy,
              size_bytes AS sizeBytes, archived_at AS archivedAt,
              pinned, reason
       FROM warehouse_state_revisions
       WHERE state_key = 'main'
       ORDER BY archived_at DESC, revision DESC
       LIMIT ?`,
    ).bind(STATE_HISTORY_LIST_LIMIT).all(),
    env.DB.prepare(
      `SELECT MIN(archived_at) AS archivedAt
       FROM warehouse_state_revisions
       WHERE state_key = 'main'`,
    ).first<{ archivedAt: string | null }>(),
    env.DB.prepare(
      `SELECT revision, updated_at AS updatedAt
       FROM warehouse_full_state
       WHERE state_key = 'main'`,
    ).first<{ revision: number; updatedAt: string }>(),
  ]);
  const revisions = result.results ?? [];
  return Response.json({
    revisions,
    oldestArchivedAt: oldest?.archivedAt ?? null,
    currentRevision: current?.revision ?? 0,
    currentUpdatedAt: current?.updatedAt ?? null,
    retention: {
      fullDetailHours: STATE_HISTORY_FULL_DETAIL_HOURS,
      hourlyDays: STATE_HISTORY_HOURLY_DAYS,
      maximumDays: STATE_HISTORY_RETENTION_DAYS,
      maximumRows: STATE_HISTORY_MAX_ROWS,
    },
  });
}

export async function POST(request: Request) {
  const auth = await requireUser(request, ["owner"]);
  if (auth.response) return auth.response;
  if (!auth.user) {
    return Response.json({ error: "Требуется авторизация" }, { status: 401 });
  }
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
      "SELECT revision, payload FROM warehouse_full_state WHERE state_key = 'main'",
    ).first<{ revision: number; payload: string }>(),
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
  let archivedValue: unknown;
  try {
    archivedValue = JSON.parse(archived.payload);
  } catch {
    return Response.json({ error: "Архивная ревизия повреждена" }, { status: 500 });
  }
  let currentValue: unknown;
  let currentJsonDamaged = false;
  try {
    currentValue = JSON.parse(current.payload);
  } catch {
    currentJsonDamaged = true;
  }
  const prepared = prepareWarehouseStateRestore(archivedValue, currentValue);
  if (!prepared) {
    return Response.json({ error: "Архивная ревизия повреждена" }, { status: 500 });
  }
  const currentStateDamaged = currentJsonDamaged || prepared.currentStateDamaged;
  const restoredPayload = JSON.stringify(prepared.state);
  const revision = expectedRevision + 1;
  const updatedAt = new Date().toISOString();
  const archivedAt = stateHistoryArchiveTimestamp();
  let results;
  try {
    results = await env.DB.batch([
      // Always preserve the state being replaced. A restore is destructive and
      // must itself be reversible even when the regular five-minute sampler
      // has not captured the latest revision yet.
      env.DB.prepare(
        `INSERT OR REPLACE INTO warehouse_state_revisions
           (state_key, revision, payload, updated_at, updated_by, size_bytes, archived_at, pinned, reason)
         SELECT state_key, revision, payload, updated_at, updated_by, length(payload), ?, 1, 'state_restore'
         FROM warehouse_full_state
         WHERE state_key = 'main' AND revision = ?`,
      ).bind(archivedAt, expectedRevision),
      env.DB.prepare(
        `UPDATE warehouse_full_state
         SET revision = ?, payload = ?, updated_at = ?, updated_by = ?
         WHERE state_key = 'main' AND revision = ?`,
      ).bind(revision, restoredPayload, updatedAt, auth.user.callsign, expectedRevision),
      env.DB.prepare(STATE_HISTORY_PRUNE_SQL).bind(...stateHistoryPruneBindings()),
      env.DB.prepare(STATE_HISTORY_CAP_SQL).bind(STATE_HISTORY_MAX_ROWS),
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
                TRIM(CAST(json_extract(item_entry.value, '$.id') AS TEXT))
         FROM warehouse_full_state,
              json_each(warehouse_full_state.payload, '$.items') AS item_entry
         WHERE warehouse_full_state.state_key = 'main'
           AND warehouse_full_state.revision = ?
           AND item_entry.type = 'object'
           AND TRIM(CAST(json_extract(item_entry.value, '$.id') AS TEXT)) <> ''`,
      ).bind(revision),
      env.DB.prepare(
        `DELETE FROM warehouse_state_inventory_acts
         WHERE state_key = 'main'
           AND EXISTS (
             SELECT 1 FROM warehouse_full_state
             WHERE state_key = 'main' AND revision = ?
           )`,
      ).bind(revision),
      env.DB.prepare(
        `INSERT INTO warehouse_state_inventory_acts (state_key, act_id, header_json)
         SELECT warehouse_full_state.state_key,
                TRIM(CAST(json_extract(inventory_entry.value, '$.id') AS TEXT)),
                json(inventory_entry.value)
         FROM warehouse_full_state,
              json_each(warehouse_full_state.payload, '$.inventoryActs') AS inventory_entry
         WHERE warehouse_full_state.state_key = 'main'
           AND warehouse_full_state.revision = ?
           AND inventory_entry.type = 'object'
           AND TRIM(CAST(json_extract(inventory_entry.value, '$.id') AS TEXT)) <> ''
         ON CONFLICT(state_key, act_id) DO UPDATE
         SET header_json = excluded.header_json`,
      ).bind(revision),
      // Old snapshots may reference a product card that was deliberately
      // deleted after the snapshot was captured. Never recreate a dangling
      // deletion-guard index for such a card.
      env.DB.prepare(
        `DELETE FROM warehouse_state_items
         WHERE state_key = 'main'
           AND item_id NOT IN (SELECT id FROM products)
           AND EXISTS (
             SELECT 1 FROM warehouse_full_state
             WHERE state_key = 'main' AND revision = ?
           )`,
      ).bind(revision),
    ]);
  } catch (error) {
    console.error("warehouse state restore failed", error);
    await audit(
      auth.user,
      "state_restore_failed",
      `Архивная ревизия ${targetRevision} · текущая ревизия ${expectedRevision}`,
    ).catch((auditError) => console.error("warehouse restore failure audit failed", auditError));
    return Response.json(
      { error: "Сервер не смог восстановить ревизию. Данные не изменены" },
      { status: 507 },
    );
  }
  if (Number(results[1].meta?.changes ?? 0) !== 1) {
    const latest = await env.DB.prepare(
      "SELECT revision FROM warehouse_full_state WHERE state_key = 'main'",
    ).first<{ revision: number }>();
    return Response.json(
      { error: "Склад уже изменён другим пользователем", conflict: true, currentRevision: latest?.revision ?? 0 },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }
  const discardedItemReferences = Number(results[8].meta?.changes ?? 0);
  await audit(
    auth.user,
    "state_restored",
    `Архивная ревизия ${targetRevision} восстановлена как ревизия ${revision}`
      + (prepared.legacySchemaAdjusted ? " · версия старого снимка приведена к поддерживаемой" : "")
      + (currentStateDamaged ? " · текущее состояние было нечитаемо" : "")
      + (currentJsonDamaged ? " · текущие черновики прочитать невозможно" : "")
      + (prepared.discardedCurrentDrafts > 0
        ? ` · отброшено повреждённых черновиков: ${prepared.discardedCurrentDrafts}`
        : "")
      + (discardedItemReferences > 0
        ? ` · отброшено ссылок на удалённые карточки: ${discardedItemReferences}`
        : ""),
  ).catch((error) => console.error("warehouse state restore audit failed", error));
  const warnings = [
    currentStateDamaged
      ? "Текущее состояние склада было повреждено; откат выполнен по архивной ревизии"
      : "",
    currentJsonDamaged
      ? "Текущие черновики инвентаризации прочитать не удалось; начатые пересчёты необходимо выполнить заново"
      : "",
    prepared.discardedCurrentDrafts > 0
      ? `Отброшено повреждённых черновиков инвентаризации: ${prepared.discardedCurrentDrafts}`
      : "",
    prepared.legacySchemaAdjusted
      ? "Старая архивная ревизия приведена к текущей поддерживаемой версии схемы"
      : "",
  ].filter(Boolean);
  return Response.json({
    revision,
    restoredFrom: targetRevision,
    updatedAt,
    discardedItemReferences,
    legacySchemaAdjusted: prepared.legacySchemaAdjusted,
    currentStateDamaged,
    discardedCurrentDrafts: prepared.discardedCurrentDrafts,
    warning: warnings.length ? warnings.join(" · ") : undefined,
  });
}
