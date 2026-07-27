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
  return Boolean(assignment)
    && normalizedAssignment(entry?.post ?? entry?.name) === assignment;
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
  for (const key of ["id", "eventId"]) {
    const candidate = String(entry[key] ?? "").trim();
    if (candidate) return `${key}:${candidate}`;
  }
  const number = String(entry.no ?? entry.number ?? "").trim();
  if (number) {
    // Legacy records did not have immutable ids. A document number alone is
    // positional and used to be reusable after deletion, so include immutable
    // creation attributes in the compatibility key.
    const discriminator = [
      entry.kind,
      Number(entry.createdAt) > 0 ? entry.createdAt : entry.date,
      entry.itemId ?? entry.item,
      entry.orderNo,
      entry.serial,
      entry.to,
    ].map((part) => String(part ?? "").trim()).join("|");
    return `number:${number}|${discriminator}`;
  }
  return "";
}

const MUTABLE_HISTORY_FIELDS = new Set([
  "status",
  "materials",
  "participants",
  "works",
  "issuedSnapshot",
  "actionTypes",
  "resultText",
  "otkPassed",
  "planQty",
  "factQty",
  "mismatchDecision",
  "mismatchReason",
  "reworkReason",
  "approvalNote",
  "approvalReason",
  "approvedBy",
  "approvedAt",
  "submittedAt",
  "warehouseAcceptedAt",
  "warehouseAcceptedBy",
  "returnedAt",
  "acceptedAt",
  "workDoc",
  "applicationPhoto",
  "applicationPhotoMedia",
  "photo",
  "photoMedia",
  "updatedAt",
]);

function canonicalHistoryValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalHistoryValue);
  const entry = record(value);
  if (!entry) return value;
  return Object.fromEntries(
    Object.keys(entry)
      .sort()
      .filter((key) => !(key === "createdAt" && Number(entry[key]) === 0))
      .map((key) => [key, canonicalHistoryValue(entry[key])]),
  );
}

function canonicalHistoryJson(value: unknown) {
  return JSON.stringify(canonicalHistoryValue(value));
}

function mutableRecordPreserved(previousValue: unknown, nextValue: unknown) {
  const previous = record(previousValue);
  const next = record(nextValue);
  if (!previous || !next) return canonicalHistoryJson(previousValue) === canonicalHistoryJson(nextValue);
  for (const key of Object.keys(previous)) {
    if (!(key in next)) return false;
    if (
      !MUTABLE_HISTORY_FIELDS.has(key)
      && canonicalHistoryJson(previous[key]) !== canonicalHistoryJson(next[key])
    ) {
      return false;
    }
  }
  return true;
}

function mutableHistoryPreserved(previousValue: unknown, nextValue: unknown) {
  const nextRows = rows(nextValue);
  const nextByKey = new Map<string, unknown>();
  for (const value of nextRows) {
    const key = stableRecordKey(value);
    if (!key) continue;
    if (nextByKey.has(key)) return false;
    nextByKey.set(key, value);
  }
  const nextUnkeyed = new Map<string, number>();
  for (const value of nextRows.filter((entry) => !stableRecordKey(entry))) {
    const serialized = canonicalHistoryJson(value);
    nextUnkeyed.set(serialized, (nextUnkeyed.get(serialized) ?? 0) + 1);
  }
  return rows(previousValue).every((value) => {
    const key = stableRecordKey(value);
    if (key) {
      const next = nextByKey.get(key);
      return next != null && mutableRecordPreserved(value, next);
    }
    const serialized = canonicalHistoryJson(value);
    const count = nextUnkeyed.get(serialized) ?? 0;
    if (count <= 0) return false;
    nextUnkeyed.set(serialized, count - 1);
    return true;
  });
}

function immutableHistoryPreserved(previousValue: unknown, nextValue: unknown) {
  const counts = new Map<string, number>();
  for (const value of rows(nextValue)) {
    const serialized = canonicalHistoryJson(value);
    counts.set(serialized, (counts.get(serialized) ?? 0) + 1);
  }
  for (const value of rows(previousValue)) {
    const serialized = canonicalHistoryJson(value);
    const count = counts.get(serialized) ?? 0;
    if (count <= 0) return false;
    counts.set(serialized, count - 1);
  }
  return true;
}

const MAX_FEED_ROWS_PER_WRITE = 200;
const NO_MUTABLE_FEED_FIELDS = new Set<string>();
const MUTABLE_NOTIFICATION_FIELDS = new Set(["read"]);

function feedRowPreserved(
  previousValue: unknown,
  nextValue: unknown,
  mutableFields: ReadonlySet<string>,
) {
  const previous = record(previousValue);
  const next = record(nextValue);
  if (!previous || !next) {
    return canonicalHistoryJson(previousValue) === canonicalHistoryJson(nextValue);
  }
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    if (mutableFields.has(key)) continue;
    if (canonicalHistoryJson(previous[key]) !== canonicalHistoryJson(next[key])) return false;
  }
  return true;
}

type RollingHistoryIssue = {
  kind: "mutation" | "too_many_new_rows";
  addedRows: number;
} | null;

function rollingHistoryIssue(
  previousValue: unknown,
  nextValue: unknown,
  windowLimit: number,
  mutableFields: ReadonlySet<string>,
): RollingHistoryIssue {
  const previousRows = rows(previousValue);
  const nextRows = rows(nextValue);
  if (nextRows.length < previousRows.length) {
    return { kind: "mutation", addedRows: 0 };
  }
  if (nextRows.length > windowLimit) {
    return { kind: "mutation", addedRows: Math.max(0, nextRows.length - previousRows.length) };
  }
  if (previousRows.length < windowLimit) {
    // New feed rows are prepended. Before the window is full, every previous
    // row must remain as an unchanged suffix.
    const added = nextRows.length - previousRows.length;
    const suffix = nextRows.slice(nextRows.length - previousRows.length);
    const preserved = suffix.every(
      (value, index) => feedRowPreserved(previousRows[index], value, mutableFields),
    );
    if (!preserved) return { kind: "mutation", addedRows: added };
    return added > MAX_FEED_ROWS_PER_WRITE
      ? { kind: "too_many_new_rows", addedRows: added }
      : null;
  }
  // Once the rolling window is full, only an unchanged prefix of the previous
  // window may remain after newly prepended rows push the oldest tail out.
  // Search the whole window so a legitimate oversized offline batch can be
  // reported separately from a forged replacement of existing history.
  for (let added = 0; added < nextRows.length; added += 1) {
    const retained = nextRows.length - added;
    if (retained <= 0) break;
    if (nextRows.slice(added).every(
      (value, index) => feedRowPreserved(previousRows[index], value, mutableFields),
    )) {
      return added > MAX_FEED_ROWS_PER_WRITE
        ? { kind: "too_many_new_rows", addedRows: added }
        : null;
    }
  }
  return { kind: "mutation", addedRows: 0 };
}

/**
 * Every writer except the owner may append warehouse history and advance
 * document statuses, but cannot erase or replace already recorded business
 * history by submitting a handcrafted full snapshot.
 */
export function warehouseHistoryMutationIssue(
  previous: WarehouseState,
  next: WarehouseState,
  role: string,
) {
  if (role === "owner") return null;
  const auditFeedIssue = rollingHistoryIssue(
    previous.auditLog,
    next.auditLog,
    2_000,
    NO_MUTABLE_FEED_FIELDS,
  );
  const notificationFeedIssue = rollingHistoryIssue(
    previous.notifications,
    next.notifications,
    2_000,
    MUTABLE_NOTIFICATION_FIELDS,
  );
  if (
    auditFeedIssue?.kind === "too_many_new_rows"
    || notificationFeedIssue?.kind === "too_many_new_rows"
  ) {
    return {
      status: 403 as const,
      error: `За одну синхронизацию можно добавить не более ${MAX_FEED_ROWS_PER_WRITE} новых записей журнала. Подключите устройство к серверу и повторите синхронизацию меньшими пакетами`,
      code: "too_many_new_rows" as const,
      auditRowsAdded: auditFeedIssue?.addedRows ?? 0,
      notificationRowsAdded: notificationFeedIssue?.addedRows ?? 0,
    };
  }
  if (
    !mutableHistoryPreserved(previous.docs, next.docs)
    || !mutableHistoryPreserved(previous.extIssues, next.extIssues)
    || !immutableHistoryPreserved(previous.stockTransfers, next.stockTransfers)
    || !immutableHistoryPreserved(previous.inventoryActs, next.inventoryActs)
    || auditFeedIssue?.kind === "mutation"
    || notificationFeedIssue?.kind === "mutation"
  ) {
    return {
      status: 403 as const,
      error: "Эта роль не может удалять или подменять документы и историю складских операций",
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
