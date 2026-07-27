import { env } from "cloudflare:workers";
import { audit, requireUser } from "@/lib/auth";
import { readJsonObject } from "@/lib/http";
import {
  STATE_HISTORY_CAP_SQL,
  STATE_HISTORY_MAX_ROWS,
  STATE_HISTORY_PRUNE_SQL,
  stateHistoryArchiveTimestamp,
  stateHistoryPruneBindings,
} from "@/lib/state-history";
import {
  findWarehouseItemId,
  removeWarehouseItemFromState,
  warehouseItemDeletionIssue,
} from "@/lib/warehouse-state";
import type { WarehouseState } from "@/lib/warehouse-state";

export const dynamic = "force-dynamic";

type ProductRow = {
  id: string;
  name: string;
  sku: string;
  category: string;
  quantity: number;
  unit: string;
  location: string;
  minimum: number;
  created_at: string;
};

function product(row: ProductRow) {
  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    category: row.category,
    quantity: row.quantity,
    unit: row.unit,
    location: row.location,
    minimum: row.minimum,
    createdAt: row.created_at,
  };
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const result = await env.DB.prepare(
    "SELECT id, name, sku, category, quantity, unit, location, minimum, created_at FROM products ORDER BY created_at DESC",
  ).all<ProductRow>();
  return Response.json({ products: (result.results ?? []).map(product) });
}

export async function POST(request: Request) {
  const auth = await requireUser(request, ["owner", "admin", "storekeeper"]);
  if (auth.response || !auth.user) return auth.response;
  const body = await readJsonObject(request);
  if (!body) return Response.json({ error: "Некорректный JSON" }, { status: 400 });
  const name = String(body.name ?? "").trim();
  const sku = String(body.sku ?? "").trim();
  const category = String(body.category ?? "").trim();
  const unit = String(body.unit ?? "шт").trim() || "шт";
  const location = String(body.location ?? "").trim();
  const quantity = Number(body.quantity ?? 0);
  const minimum = Number(body.minimum ?? 0);

  if (!name || !sku) return Response.json({ error: "Укажите название и артикул" }, { status: 400 });
  if (!Number.isFinite(quantity) || quantity < 0 || !Number.isFinite(minimum) || minimum < 0) {
    return Response.json({ error: "Количество и минимум должны быть неотрицательными числами" }, { status: 400 });
  }

  const row: ProductRow = {
    id: crypto.randomUUID(),
    name,
    sku,
    category,
    quantity,
    unit,
    location,
    minimum,
    created_at: new Date().toISOString(),
  };

  try {
    await env.DB.prepare(
      "INSERT INTO products (id, name, sku, category, quantity, unit, location, minimum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(row.id, row.name, row.sku, row.category, row.quantity, row.unit, row.location, row.minimum, row.created_at).run();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    if (message.includes("UNIQUE")) return Response.json({ error: "Товар с таким артикулом уже существует" }, { status: 409 });
    throw cause;
  }

  await audit(auth.user, "product_created", `${row.name} · ${row.sku}`);
  return Response.json({ product: product(row) }, { status: 201 });
}

export async function DELETE(request: Request) {
  const auth = await requireUser(request, ["owner", "admin"]);
  if (auth.response || !auth.user) return auth.response;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "Не указан товар" }, { status: 400 });
  const existing = await env.DB.prepare(
    "SELECT name, sku, quantity FROM products WHERE id = ?",
  ).bind(id).first<{ name: string; sku: string; quantity: number }>();
  if (!existing) return Response.json({ error: "Товар не найден" }, { status: 404 });
  if (Number(existing.quantity) > 0) {
    return Response.json(
      { error: "Нельзя удалить карточку: на складе есть остаток" },
      { status: 409 },
    );
  }
  const stateRow = await env.DB.prepare(
    "SELECT revision, payload FROM warehouse_full_state WHERE state_key = 'main'",
  ).first<{ revision: number; payload: string }>();
  if (stateRow) {
    let state: WarehouseState | null = null;
    try {
      const parsed = JSON.parse(stateRow.payload) as unknown;
      state = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as WarehouseState
        : null;
    } catch {
      return Response.json(
        { error: "Серверный снимок повреждён. Карточка не удалена" },
        { status: 500 },
      );
    }
    if (!state) {
      return Response.json(
        { error: "Серверный снимок повреждён. Карточка не удалена" },
        { status: 500 },
      );
    }
    const warehouseItemId = findWarehouseItemId(state, id);
    if (warehouseItemId) {
      const issue = warehouseItemDeletionIssue(state, warehouseItemId);
      if (issue) {
        return Response.json(
          { error: `Нельзя удалить карточку: ${issue}` },
          { status: 409 },
        );
      }
      const nextState = removeWarehouseItemFromState(state, warehouseItemId);
      const nextPayload = JSON.stringify(nextState);
      const updatedAt = new Date().toISOString();
      const archivedAt = stateHistoryArchiveTimestamp();
      const results = await env.DB.batch([
        env.DB.prepare(
          `INSERT OR REPLACE INTO warehouse_state_revisions
             (state_key, revision, payload, updated_at, updated_by, size_bytes, archived_at)
           SELECT state_key, revision, payload, updated_at, updated_by, length(payload), ?
           FROM warehouse_full_state
           WHERE state_key = 'main' AND revision = ?`,
        ).bind(archivedAt, stateRow.revision),
        env.DB.prepare(
          `UPDATE warehouse_full_state
           SET revision = ?, payload = ?, updated_at = ?, updated_by = ?
           WHERE state_key = 'main' AND revision = ?
             AND EXISTS (SELECT 1 FROM products WHERE products.id = ?)`,
        ).bind(
          stateRow.revision + 1,
          nextPayload,
          updatedAt,
          auth.user.callsign,
          stateRow.revision,
          id,
        ),
        env.DB.prepare(STATE_HISTORY_PRUNE_SQL).bind(...stateHistoryPruneBindings()),
        env.DB.prepare(STATE_HISTORY_CAP_SQL).bind(STATE_HISTORY_MAX_ROWS),
        env.DB.prepare(
          `DELETE FROM warehouse_state_items
           WHERE state_key = 'main' AND item_id = ?
             AND EXISTS (
               SELECT 1 FROM warehouse_full_state
               WHERE state_key = 'main' AND revision = ?
                 AND NOT EXISTS (
                   SELECT 1
                   FROM json_each(warehouse_full_state.payload, '$.items')
                   WHERE TRIM(CAST(json_extract(value, '$.id') AS TEXT)) = ?
                 )
             )`,
        ).bind(warehouseItemId, stateRow.revision + 1, warehouseItemId),
        env.DB.prepare(
          `DELETE FROM products
           WHERE id = ?
             AND EXISTS (
               SELECT 1 FROM warehouse_full_state
               WHERE state_key = 'main' AND revision = ?
                 AND NOT EXISTS (
                   SELECT 1
                   FROM json_each(warehouse_full_state.payload, '$.items')
                   WHERE TRIM(CAST(json_extract(value, '$.id') AS TEXT)) = ?
                 )
             )`,
        ).bind(id, stateRow.revision + 1, warehouseItemId),
      ]);
      if (
        Number(results[1].meta?.changes ?? 0) !== 1
        || Number(results[5].meta?.changes ?? 0) !== 1
      ) {
        return Response.json(
          { error: "Склад изменён другим пользователем. Обновите данные и повторите", conflict: true },
          { status: 409 },
        );
      }
      await audit(auth.user, "product_deleted", `${existing.name} · ${existing.sku}`);
      return Response.json({ ok: true, revision: stateRow.revision + 1 });
    }
  }
  await env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
  await audit(auth.user, "product_deleted", `${existing.name} · ${existing.sku}`);
  return Response.json({ ok: true });
}
