export type WarehouseState = Record<string, unknown>;

export type WarehouseDeletionPolicy =
  | { status: 403 | 409; error: string }
  | null;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rows(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function identifier(value: unknown) {
  return String(record(value)?.id ?? "").trim();
}

function isPositive(value: unknown) {
  const quantity = Number(value);
  return Number.isFinite(quantity) && quantity > 0;
}

function referencesItem(value: unknown, itemId: string) {
  const entry = record(value);
  if (!entry) return false;
  if (String(entry.itemId ?? "").trim() === itemId) return true;
  if (String(entry.id ?? "").trim() === itemId) return true;
  return rows(entry.materials).some((material) => identifier(material) === itemId)
    || rows(entry.items).some((item) => identifier(item) === itemId);
}

export function warehouseItemIds(state: WarehouseState) {
  return new Set(rows(state.items).map(identifier).filter(Boolean));
}

export function removedWarehouseItemIds(previous: WarehouseState, next: WarehouseState) {
  const nextIds = warehouseItemIds(next);
  return [...warehouseItemIds(previous)].filter((id) => !nextIds.has(id));
}

export function findWarehouseItemId(state: WarehouseState, id: string, sku = "") {
  const normalizedId = id.trim();
  const normalizedSku = sku.trim();
  for (const value of rows(state.items)) {
    const item = record(value);
    if (!item) continue;
    const itemId = String(item.id ?? "").trim();
    if (
      (normalizedId && itemId === normalizedId)
      || (normalizedSku && String(item.sku ?? "").trim() === normalizedSku)
    ) {
      return itemId;
    }
  }
  return "";
}

export function warehouseItemDeletionIssue(state: WarehouseState, itemId: string) {
  const item = rows(state.items)
    .map(record)
    .find((candidate) => String(candidate?.id ?? "").trim() === itemId);
  if (!item) return null;

  if (isPositive(item.stock) || isPositive(item.ext)) {
    return "по товару есть остаток на складе или активная выдача";
  }
  const postBalances = record(item.posts);
  if (postBalances && Object.values(postBalances).some(isPositive)) {
    return "товар числится на посту";
  }
  if (rows(item.lots).some((lot) => {
    const value = record(lot);
    return isPositive(value?.qty) || isPositive(value?.q);
  })) {
    return "по товару остались партии";
  }
  if (rows(state.posts).some((postValue) => {
    const post = record(postValue);
    return rows(post?.stock).some((stockValue) => {
      const stock = record(stockValue);
      return String(stock?.id ?? "").trim() === itemId
        && (isPositive(stock?.q) || isPositive(stock?.qty));
    });
  })) {
    return "товар числится в остатках поста";
  }
  if (rows(state.docs).some((document) => referencesItem(document, itemId))) {
    return "товар связан с документом";
  }
  if (rows(state.extIssues).some((issue) => referencesItem(issue, itemId))) {
    return "товар связан с выдачей";
  }
  return null;
}

export function warehouseDeletionPolicy(
  previous: WarehouseState,
  next: WarehouseState,
  role: string,
): WarehouseDeletionPolicy {
  const removed = removedWarehouseItemIds(previous, next);
  if (!removed.length) return null;
  if (role !== "owner" && role !== "admin") {
    return {
      status: 403,
      error: "Удалять карточки товара может только владелец или администратор",
    };
  }
  for (const itemId of removed) {
    const issue = warehouseItemDeletionIssue(previous, itemId);
    if (issue) {
      return {
        status: 409,
        error: `Нельзя удалить карточку: ${issue}`,
      };
    }
  }
  return null;
}
