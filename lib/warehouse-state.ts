export type WarehouseState = Record<string, unknown>;

export type WarehouseDeletionPolicy =
  | { status: 403 | 409; error: string }
  | null;

export type WarehouseStateViewer = {
  id?: string;
  role: string;
  assignment: string;
};

export type WorkerPostStateMergeResult =
  | { state: WarehouseState; issue: null }
  | { state: null; issue: { status: 403 | 409; error: string } };

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
  nestedKey: "items" | "diffs" | "lines" | "materials",
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
    ...rows(state.inventoryActs).flatMap((value) => rows(record(value)?.lines)),
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
  const viewerId = String(viewer.id ?? "").trim();
  const ownCycleCountDrafts = viewerId && record(state.cycleCountDrafts)?.[viewerId]
    ? { [viewerId]: record(state.cycleCountDrafts)?.[viewerId] }
    : {};
  if (viewer.role !== "worker") {
    return {
      ...state,
      cycleCountDrafts: ownCycleCountDrafts,
    };
  }
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
    cycleCountDrafts: ownCycleCountDrafts,
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

function withoutKeys(value: unknown, keys: ReadonlySet<string>) {
  const entry = record(value);
  if (!entry) return value;
  return Object.fromEntries(
    Object.entries(entry).filter(([key]) => !keys.has(key)),
  );
}

function workerPostIssue(error: string, status: 403 | 409 = 403): WorkerPostStateMergeResult {
  return { state: null, issue: { status, error } };
}

const WORKER_STATE_COLLECTIONS = new Set(["items", "posts", "docs", "auditLog", "notifications"]);
const WORKER_DERIVED_STATE_FIELDS = new Set(["documentSeq", "notificationSeq"]);
const WORKER_ITEM_MUTABLE_FIELDS = new Set(["posts", "history"]);
const WORKER_POST_MUTABLE_FIELDS = new Set(["stock", "repairs"]);
const WORKER_WORK_MUTABLE_FIELDS = new Set([
  "status",
  "materials",
  "participants",
  "works",
  "actionTypes",
  "resultText",
  "otkPassed",
  "factQty",
  "submittedAt",
  "updatedAt",
]);
const WORK_SERVER_CONTROLLED_FIELDS = new Set([
  "approvedBy",
  "approvedAt",
  "approvalNote",
  "approvalReason",
  "mismatchReason",
  "warehouseAcceptedAt",
  "warehouseAcceptedBy",
  "returnedAt",
  "acceptedAt",
]);

function keyedRows(value: unknown) {
  const result = new Map<string, Record<string, unknown>>();
  for (const rowValue of rows(value)) {
    const row = record(rowValue);
    const key = stableRecordKey(rowValue);
    if (!row || !key || result.has(key)) return null;
    result.set(key, row);
  }
  return result;
}

function documentSequenceBaseline(state: WarehouseState, kind: "defekt" | "work") {
  const floor = kind === "work" ? 199 : 99;
  const stored = Number(record(state.documentSeq)?.[kind]);
  const highestDocumentNumber = rows(state.docs).reduce((highest, value) => {
    const document = record(value);
    if (String(document?.kind ?? "") !== kind) return highest;
    const match = String(document?.no ?? "").trim().match(/^(?:ДФ|АВР)-0*(\d+)(?:\/.*)?$/i);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  return Math.max(
    floor,
    Number.isSafeInteger(stored) && stored >= 0 ? stored : 0,
    highestDocumentNumber,
  );
}

function workerDocumentSequence(
  previous: WarehouseState,
  incoming: WarehouseState,
  addedDocs: Record<string, unknown>[],
) {
  const incomingSequence = record(incoming.documentSeq);
  if (
    !incomingSequence
    || Object.keys(incomingSequence).some((key) => key !== "defekt" && key !== "work")
  ) return null;
  const result: Record<"defekt" | "work", number> = { defekt: 0, work: 0 };
  for (const kind of ["defekt", "work"] as const) {
    const added = addedDocs.filter((document) => String(document.kind ?? "") === kind).length;
    const expected = documentSequenceBaseline(previous, kind) + added;
    if (Number(incomingSequence[kind]) !== expected) return null;
    result[kind] = expected;
  }
  return result;
}

function workerDocumentChangeAllowed(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  addedWorkNumbers: ReadonlySet<string>,
) {
  const kind = String(previous.kind ?? "");
  if (kind !== String(next.kind ?? "")) return false;
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  if (kind === "defekt") {
    for (const key of keys) {
      if (key === "updatedAt") continue;
      if (key === "workDoc") {
        const before = String(previous.workDoc ?? "");
        const after = String(next.workDoc ?? "");
        if (before === after) continue;
        if (!before && addedWorkNumbers.has(after)) continue;
        return false;
      }
      if (canonicalHistoryJson(previous[key]) !== canonicalHistoryJson(next[key])) return false;
    }
    return true;
  }
  if (kind !== "work") return false;
  for (const key of keys) {
    if (key === "mismatchDecision") {
      const before = String(previous.mismatchDecision ?? "");
      const after = String(next.mismatchDecision ?? "");
      if (before === after) continue;
      if (
        before === "rework"
        && !after
        && normalizedStatus(next.status) === "расхождение"
      ) continue;
      return false;
    }
    if (WORKER_WORK_MUTABLE_FIELDS.has(key)) continue;
    if (canonicalHistoryJson(previous[key]) !== canonicalHistoryJson(next[key])) return false;
  }
  const beforeStatus = normalizedStatus(previous.status);
  const afterStatus = normalizedStatus(next.status);
  if (beforeStatus === afterStatus) return true;
  return (
    (beforeStatus === "черновик" || beforeStatus === "на доработке")
    && (afterStatus === "ожидает согласования" || afterStatus === "расхождение")
  );
}

/**
 * Merge a worker's projected post snapshot back into the complete warehouse
 * graph. The worker may create and edit repair documents for their assigned
 * post, but cannot use the full-state transport to alter another post,
 * warehouse stock, approvals, inventory, accounts or business history.
 */
export function mergeWorkerPostState(
  previous: WarehouseState,
  incoming: WarehouseState,
  viewer: WarehouseStateViewer,
): WorkerPostStateMergeResult {
  if (viewer.role !== "worker") {
    return workerPostIssue("Частичное состояние доступно только работнику");
  }
  const assignment = normalizedAssignment(viewer.assignment);
  if (!assignment) return workerPostIssue("Работнику не назначен пост");

  const projected = projectWarehouseStateForUser(previous, viewer);
  const topLevelKeys = new Set([...Object.keys(projected), ...Object.keys(incoming)]);
  for (const key of topLevelKeys) {
    if (WORKER_STATE_COLLECTIONS.has(key) || WORKER_DERIVED_STATE_FIELDS.has(key)) continue;
    if (canonicalHistoryJson(projected[key]) !== canonicalHistoryJson(incoming[key])) {
      return workerPostIssue("Работник может изменять только документы своего поста");
    }
  }

  const previousDocs = keyedRows(projected.docs);
  const incomingDocs = keyedRows(incoming.docs);
  if (!previousDocs || !incomingDocs) {
    return workerPostIssue("Документы содержат повторяющиеся или некорректные идентификаторы", 409);
  }
  for (const document of incomingDocs.values()) {
    if (!belongsToAssignment(document, assignment)) {
      return workerPostIssue("Работник может сохранять документы только своего поста");
    }
  }
  for (const key of previousDocs.keys()) {
    if (!incomingDocs.has(key)) return workerPostIssue("Работник не может удалять документы");
  }

  const addedDocs = [...incomingDocs]
    .filter(([key]) => !previousDocs.has(key))
    .map(([, document]) => document);
  if (addedDocs.length > 2) {
    return workerPostIssue("За одну синхронизацию можно создать дефектовку и связанный акт работ", 409);
  }
  const allPreviousNumbers = new Set(
    rows(previous.docs).map((value) => String(record(value)?.no ?? "").trim()).filter(Boolean),
  );
  const addedNumbers = new Set<string>();
  for (const document of addedDocs) {
    const id = String(document.id ?? "").trim();
    const no = String(document.no ?? "").trim();
    if (!id || !no || allPreviousNumbers.has(no) || addedNumbers.has(no)) {
      return workerPostIssue("Новый документ не имеет уникального номера и идентификатора", 409);
    }
    addedNumbers.add(no);
  }
  const addedWorks = addedDocs.filter((document) => String(document.kind ?? "") === "work");
  const addedWorkNumbers = new Set(addedWorks.map((document) => String(document.no ?? "").trim()));
  const addedDefects = addedDocs.filter((document) => String(document.kind ?? "") === "defekt");
  if (addedWorks.length > 1 || addedDefects.length > 1 || addedDocs.length !== addedWorks.length + addedDefects.length) {
    return workerPostIssue("Работник может создавать только акт дефектовки и акт выполненных работ", 409);
  }
  const nextDocumentSequence = workerDocumentSequence(previous, incoming, addedDocs);
  if (!nextDocumentSequence) {
    return workerPostIssue("Счётчик документов не соответствует созданным актам", 409);
  }

  for (const defect of addedDefects) {
    if (
      normalizedStatus(defect.status) !== "закрыт"
      || !String(defect.item ?? "").trim()
      || !String(defect.orderNo ?? "").trim()
      || !String(defect.callsign ?? "").trim()
      || !String(defect.fault ?? "").trim()
      || !String(defect.verdict ?? "").trim()
      || !rows(defect.defects).length
    ) {
      return workerPostIssue("Акт дефектовки заполнен не полностью", 409);
    }
    const workNo = String(defect.workDoc ?? "").trim();
    if (workNo && !addedWorkNumbers.has(workNo)) {
      return workerPostIssue("Дефектовка ссылается на неизвестный акт работ", 409);
    }
  }
  for (const work of addedWorks) {
    if (normalizedStatus(work.status) !== "черновик") {
      return workerPostIssue("Новый акт выполненных работ должен быть черновиком", 409);
    }
    if (
      [...WORK_SERVER_CONTROLLED_FIELDS].some((key) => work[key] != null)
      || String(work.mismatchDecision ?? "").trim()
    ) {
      return workerPostIssue("Согласование акта выполняет только администратор");
    }
    const defectNo = String(work.defektDoc ?? "").trim();
    const source = [...incomingDocs.values()].find(
      (document) => String(document.no ?? "").trim() === defectNo
        && String(document.kind ?? "") === "defekt",
    );
    if (!source || String(source.workDoc ?? "").trim() !== String(work.no ?? "").trim()) {
      return workerPostIssue("Акт выполненных работ должен быть связан с дефектовкой своего поста", 409);
    }
  }
  for (const [key, before] of previousDocs) {
    const after = incomingDocs.get(key);
    if (!after || !workerDocumentChangeAllowed(before, after, addedWorkNumbers)) {
      return workerPostIssue("Работник не может изменять служебные поля или согласование документа");
    }
  }

  const previousItems = new Map(
    rows(projected.items).map((value) => [identifier(value), record(value)] as const),
  );
  const incomingItems = new Map(
    rows(incoming.items).map((value) => [identifier(value), record(value)] as const),
  );
  if (
    previousItems.size !== incomingItems.size
    || [...previousItems.keys()].some((id) => !id || !incomingItems.has(id))
  ) {
    return workerPostIssue("Работник не может создавать или удалять карточки товара");
  }
  const expectedItemDeltas = new Map<string, Record<string, unknown>[]>();
  for (const defect of addedDefects) {
    if (String(defect.verdict ?? "").includes("Не подлежит")) continue;
    const itemId = String(defect.itemId ?? "").trim();
    if (!itemId) continue;
    if (!previousItems.has(itemId)) return workerPostIssue("Связанная карточка товара не найдена", 409);
    const list = expectedItemDeltas.get(itemId) ?? [];
    list.push(defect);
    expectedItemDeltas.set(itemId, list);
  }

  const itemUpdates = new Map<string, { balance: number; history: unknown[] }>();
  for (const [id, before] of previousItems) {
    const after = incomingItems.get(id);
    if (!before || !after) return workerPostIssue("Карточка товара повреждена", 409);
    if (
      canonicalHistoryJson(withoutKeys(before, WORKER_ITEM_MUTABLE_FIELDS))
      !== canonicalHistoryJson(withoutKeys(after, WORKER_ITEM_MUTABLE_FIELDS))
    ) {
      return workerPostIssue("Работник не может изменять складскую карточку товара");
    }
    const beforePosts = record(before.posts) ?? {};
    const afterPosts = record(after.posts) ?? {};
    if (
      Object.keys(afterPosts).some((post) => normalizedAssignment(post) !== assignment)
      || Object.keys(beforePosts).some((post) => normalizedAssignment(post) !== assignment)
    ) {
      return workerPostIssue("Работник не может изменять остатки другого поста");
    }
    const beforeBalance = Number(Object.values(beforePosts)[0] ?? 0);
    const afterBalance = Number(Object.values(afterPosts)[0] ?? 0);
    const defects = expectedItemDeltas.get(id) ?? [];
    if (!Number.isFinite(afterBalance) || afterBalance - beforeBalance !== defects.length) {
      return workerPostIssue("Изменение остатка поста не соответствует новой дефектовке");
    }
    const beforeHistory = rows(before.history);
    const afterHistory = rows(after.history);
    if (
      afterHistory.length !== beforeHistory.length + defects.length
      || !beforeHistory.every(
        (entry, index) => canonicalHistoryJson(entry) === canonicalHistoryJson(afterHistory[index]),
      )
    ) {
      return workerPostIssue("История карточки не соответствует новой дефектовке");
    }
    const newHistory = afterHistory.slice(beforeHistory.length).map((entry, index) => ({
      ...(record(entry) ?? {}),
      post: String(defects[index]?.post ?? viewer.assignment).trim(),
    }));
    itemUpdates.set(id, { balance: afterBalance, history: newHistory });
  }

  const previousPosts = rows(projected.posts);
  const incomingPosts = rows(incoming.posts);
  if (previousPosts.length !== 1 || incomingPosts.length !== 1) {
    return workerPostIssue("Назначенный пост не найден", 409);
  }
  const beforePost = record(previousPosts[0]);
  const afterPost = record(incomingPosts[0]);
  if (
    !beforePost || !afterPost
    || !belongsToAssignment(beforePost, assignment)
    || !belongsToAssignment(afterPost, assignment)
    || canonicalHistoryJson(withoutKeys(beforePost, WORKER_POST_MUTABLE_FIELDS))
      !== canonicalHistoryJson(withoutKeys(afterPost, WORKER_POST_MUTABLE_FIELDS))
  ) {
    return workerPostIssue("Работник не может изменять настройки поста");
  }
  const beforeRepairs = rows(beforePost.repairs);
  const afterRepairs = rows(afterPost.repairs);
  const repairableDefects = addedDefects.filter(
    (defect) => !String(defect.verdict ?? "").includes("Не подлежит"),
  );
  if (
    afterRepairs.length !== beforeRepairs.length + repairableDefects.length
    || !beforeRepairs.every(
      (entry, index) => canonicalHistoryJson(entry) === canonicalHistoryJson(afterRepairs[index]),
    )
  ) {
    return workerPostIssue("Список ремонтов поста не соответствует новой дефектовке");
  }
  const addedRepairs = afterRepairs.slice(beforeRepairs.length);
  for (const defect of repairableDefects) {
    if (!addedRepairs.some((repair) =>
      String(record(repair)?.doc ?? "") === String(defect.no ?? "")
      && String(record(repair)?.item ?? "") === String(defect.item ?? ""))) {
      return workerPostIssue("Новая дефектовка отсутствует в списке ремонтов поста", 409);
    }
  }

  const beforeStock = new Map(rows(beforePost.stock).map((value) => [identifier(value), record(value)] as const));
  const afterStock = new Map(rows(afterPost.stock).map((value) => [identifier(value), record(value)] as const));
  const stockIds = new Set([...beforeStock.keys(), ...afterStock.keys()]);
  for (const id of stockIds) {
    if (!id) return workerPostIssue("Остаток поста содержит пустой идентификатор", 409);
    const before = beforeStock.get(id);
    const after = afterStock.get(id);
    const expectedDelta = (expectedItemDeltas.get(id) ?? []).length;
    const beforeQuantity = Number(before?.q ?? 0);
    const afterQuantity = Number(after?.q ?? 0);
    if (!after || !Number.isFinite(afterQuantity) || afterQuantity - beforeQuantity !== expectedDelta) {
      return workerPostIssue("Остаток поста не соответствует новой дефектовке");
    }
    if (
      before
      && canonicalHistoryJson(withoutKeys(before, new Set(["q"])))
        !== canonicalHistoryJson(withoutKeys(after, new Set(["q"])))
    ) {
      return workerPostIssue("Работник не может изменять партии или служебные поля остатка поста");
    }
  }

  const assignedPostName = String(beforePost.name ?? viewer.assignment).trim();
  const mergedItems = rows(previous.items).map((value) => {
    const item = record(value);
    const id = identifier(value);
    const update = itemUpdates.get(id);
    if (!item || !update) return value;
    const fullPosts = record(item.posts) ?? {};
    const nextPosts = Object.fromEntries(
      Object.entries(fullPosts).filter(([post]) => normalizedAssignment(post) !== assignment),
    );
    if (update.balance > 0) nextPosts[assignedPostName] = update.balance;
    return {
      ...item,
      posts: nextPosts,
      history: [...rows(item.history), ...update.history],
    };
  });
  const mergedPosts = rows(previous.posts).map((value) => {
    if (!belongsToAssignment(value, assignment)) return value;
    const fullPost = record(value);
    return fullPost ? {
      ...fullPost,
      stock: afterStock.size ? rows(afterPost.stock) : [],
      repairs: afterRepairs,
    } : value;
  });
  const otherDocs = rows(previous.docs).filter((value) => !belongsToAssignment(value, assignment));
  return {
    state: {
      ...previous,
      items: mergedItems,
      posts: mergedPosts,
      docs: [...rows(incoming.docs), ...otherDocs],
      documentSeq: nextDocumentSequence,
    },
    issue: null,
  };
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

function signedInventoryHistoryPreserved(previousValue: unknown, nextValue: unknown) {
  const signed = rows(previousValue).filter((value) => identifier(value));
  return immutableHistoryPreserved(signed, nextValue);
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
  // Inventory acts are signed server records. Even the owner may append a new
  // header, but an existing header can never be removed or rewritten through
  // the shared-state endpoint.
  if (!signedInventoryHistoryPreserved(previous.inventoryActs, next.inventoryActs)) {
    return {
      status: 403 as const,
      error: "Нельзя удалять или изменять сформированные акты инвентаризации",
      code: "inventory_history_mutation" as const,
    };
  }
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
      code: "mutation" as const,
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
    inventoryActs: archiveHistoryCollection(
      archiveHistoryCollection(state.inventoryActs, "diffs", itemId, item),
      "lines",
      itemId,
      item,
    ),
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
