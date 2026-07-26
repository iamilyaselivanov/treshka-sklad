export type WarehouseState = Record<string, unknown>;

export type WarehouseDeletionPolicy =
  | { status: 403 | 409; error: string }
  | null;

export type WarehouseStateViewer = {
  role: string;
  assignment: string;
};

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

function archiveReference(value: unknown, itemId: string, item: Record<string, unknown>) {
  const entry = record(value);
  if (!entry || identifier(entry) !== itemId) return value;
  return {
    ...entry,
    name: String(entry.name ?? item.name ?? "").trim(),
    sku: String(entry.sku ?? item.sku ?? "").trim(),
    unit: String(entry.unit ?? item.unit ?? "").trim(),
  };
}

function archiveHistoryCollection(
  value: unknown,
  nestedKey: "items" | "diffs" | "materials",
  itemId: string,
  item: Record<string, unknown>,
) {
  return rows(value).map((rowValue) => {
    const row = record(rowValue);
    if (!row) return rowValue;
    return {
      ...row,
      [nestedKey]: rows(row[nestedKey]).map((entry) => archiveReference(entry, itemId, item)),
    };
  });
}

function historicalReferences(state: WarehouseState, itemId: string) {
  return [
    ...rows(state.stockTransfers).flatMap((value) => rows(record(value)?.items)),
    ...rows(state.inventoryActs).flatMap((value) => rows(record(value)?.diffs)),
    ...rows(state.docs).flatMap((value) => rows(record(value)?.materials)),
    ...rows(state.extIssues).flatMap((value) => rows(record(value)?.items)),
  ].filter((value) => identifier(value) === itemId);
}

function historyArchiveIssue(
  previous: WarehouseState,
  next: WarehouseState,
  itemId: string,
) {
  const previousReferences = historicalReferences(previous, itemId);
  const references = historicalReferences(next, itemId);
  if (references.length < previousReferences.length) return "history_removed";
  const metadataMissing = references.some((value) => {
    const entry = record(value);
    return !String(entry?.name ?? "").trim() || !String(entry?.sku ?? "").trim();
  });
  return metadataMissing ? "metadata_missing" : null;
}

export function warehouseItemIds(state: WarehouseState) {
  return new Set(rows(state.items).map(identifier).filter(Boolean));
}

export function removedWarehouseItemIds(previous: WarehouseState, next: WarehouseState) {
  const nextIds = warehouseItemIds(next);
  return [...warehouseItemIds(previous)].filter((id) => !nextIds.has(id));
}

function normalizedStatus(value: unknown) {
  return String(value ?? "").trim().toLocaleLowerCase("ru-RU");
}

function normalizedAssignment(value: unknown) {
  return String(value ?? "").trim().toLocaleLowerCase("ru-RU");
}

function belongsToAssignment(value: unknown, assignment: string) {
  const entry = record(value);
  return normalizedAssignment(entry?.post ?? entry?.name) === assignment;
}

/**
 * A worker receives only their assigned post's operational slice. Managers and
 * storekeepers retain the complete warehouse snapshot.
 */
export function projectWarehouseStateForUser(
  state: WarehouseState,
  viewer: WarehouseStateViewer,
): WarehouseState {
  if (viewer.role !== "worker") return state;
  const assignment = normalizedAssignment(viewer.assignment);
  const projectedItems = rows(state.items).map((itemValue) => {
    const item = record(itemValue);
    if (!item) return itemValue;
    const postBalances = record(item.posts);
    const matchingPostBalances = postBalances
      ? Object.fromEntries(
        Object.entries(postBalances)
          .filter(([post]) => normalizedAssignment(post) === assignment),
      )
      : {};
    return {
      ...item,
      stock: 0,
      ext: 0,
      lots: [],
      history: rows(item.history).filter((entry) => {
        const post = normalizedAssignment(record(entry)?.post);
        return post && post === assignment;
      }),
      posts: matchingPostBalances,
    };
  });
  return {
    ...state,
    items: projectedItems,
    posts: rows(state.posts).filter((entry) => belongsToAssignment(entry, assignment)),
    docs: rows(state.docs).filter((entry) => belongsToAssignment(entry, assignment)),
    extIssues: rows(state.extIssues).filter((entry) => belongsToAssignment(entry, assignment)),
    stockTransfers: rows(state.stockTransfers).filter((entry) => belongsToAssignment(entry, assignment)),
    inventoryActs: [],
    auditLog: rows(state.auditLog).filter((entry) => belongsToAssignment(entry, assignment)),
    notifications: rows(state.notifications).filter((entry) => belongsToAssignment(entry, assignment)),
  };
}

function stableRecordKey(value: unknown) {
  const entry = record(value);
  if (!entry) return "";
  for (const key of ["id", "no", "number", "eventId"]) {
    const candidate = String(entry[key] ?? "").trim();
    if (candidate) return `${key}:${candidate}`;
  }
  return "";
}

function mutableHistoryPreserved(previousValue: unknown, nextValue: unknown) {
  const nextRows = rows(nextValue);
  const nextKeys = new Set(nextRows.map(stableRecordKey).filter(Boolean));
  const nextUnkeyed = new Set(
    nextRows.filter((value) => !stableRecordKey(value)).map((value) => JSON.stringify(value)),
  );
  return rows(previousValue).every((value) => {
    const key = stableRecordKey(value);
    return key ? nextKeys.has(key) : nextUnkeyed.has(JSON.stringify(value));
  });
}

function immutableHistoryPreserved(previousValue: unknown, nextValue: unknown) {
  const counts = new Map<string, number>();
  for (const value of rows(nextValue)) {
    const serialized = JSON.stringify(value);
    counts.set(serialized, (counts.get(serialized) ?? 0) + 1);
  }
  for (const value of rows(previousValue)) {
    const serialized = JSON.stringify(value);
    const count = counts.get(serialized) ?? 0;
    if (count <= 0) return false;
    counts.set(serialized, count - 1);
  }
  return true;
}

/**
 * Storekeepers may append warehouse history and advance document statuses, but
 * cannot erase already recorded documents, movements, inventory acts or audit
 * rows by submitting a handcrafted full snapshot.
 */
export function warehouseHistoryMutationIssue(
  previous: WarehouseState,
  next: WarehouseState,
  role: string,
) {
  if (role !== "storekeeper") return null;
  if (
    !mutableHistoryPreserved(previous.docs, next.docs)
    || !mutableHistoryPreserved(previous.extIssues, next.extIssues)
    || !immutableHistoryPreserved(previous.stockTransfers, next.stockTransfers)
    || !immutableHistoryPreserved(previous.inventoryActs, next.inventoryActs)
    || !immutableHistoryPreserved(previous.auditLog, next.auditLog)
  ) {
    return {
      status: 403 as const,
      error: "Кладовщик не может удалять документы и историю складских операций",
    };
  }
  return null;
}

function isClosedDocument(value: unknown) {
  const status = normalizedStatus(record(value)?.status);
  return status === "закрыт"
    || status === "закрыто"
    || status === "завершён"
    || status === "завершен"
    || status === "выполнен";
}

function isClosedExternalIssue(value: unknown) {
  const status = normalizedStatus(record(value)?.status);
  return status === "возвращено" || status === "закрыт" || status === "закрыто";
}

export function findWarehouseItemId(state: WarehouseState, id: string) {
  const normalizedId = id.trim();
  for (const value of rows(state.items)) {
    const item = record(value);
    if (!item) continue;
    const itemId = String(item.id ?? "").trim();
    if (normalizedId && itemId === normalizedId) return itemId;
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
  if (rows(state.docs).some((document) =>
    !isClosedDocument(document) && referencesItem(document, itemId))) {
    return "товар связан с незавершённым документом";
  }
  if (rows(state.extIssues).some((issue) =>
    !isClosedExternalIssue(issue) && referencesItem(issue, itemId))) {
    return "товар связан с активной выдачей";
  }
  return null;
}

export function removeWarehouseItemFromState(state: WarehouseState, itemId: string) {
  const item = rows(state.items)
    .map(record)
    .find((candidate) => String(candidate?.id ?? "").trim() === itemId);
  if (!item) return state;
  return {
    ...state,
    items: rows(state.items).filter((value) => identifier(value) !== itemId),
    posts: rows(state.posts).map((postValue) => {
      const post = record(postValue);
      if (!post) return postValue;
      return {
        ...post,
        stock: rows(post.stock).filter((stockValue) => identifier(stockValue) !== itemId),
      };
    }),
    stockTransfers: archiveHistoryCollection(state.stockTransfers, "items", itemId, item),
    inventoryActs: archiveHistoryCollection(state.inventoryActs, "diffs", itemId, item),
    docs: archiveHistoryCollection(state.docs, "materials", itemId, item),
    extIssues: archiveHistoryCollection(state.extIssues, "items", itemId, item),
  };
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
    const historyIssue = historyArchiveIssue(previous, next, itemId);
    if (historyIssue === "history_removed") {
      return {
        status: 409,
        error: "Нельзя удалить карточку одновременно с удалением связанной истории документов или движений",
      };
    }
    if (historyIssue === "metadata_missing") {
      return {
        status: 409,
        error: "Нельзя удалить карточку: в истории документов или движений отсутствует архивное название товара",
      };
    }
  }
  return null;
}
