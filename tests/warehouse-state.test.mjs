import assert from "node:assert/strict";
import test from "node:test";
import {
  findWarehouseItemId,
  mergeWorkerPostState,
  projectWarehouseStateForUser,
  removeWarehouseItemFromState,
  warehouseDeletionPolicy,
  warehouseHistoryMutationIssue,
  warehouseItemDeletionIssue,
} from "../lib/warehouse-state.ts";
import {
  CURRENT_WAREHOUSE_SCHEMA_VERSION,
  normalizedWarehouseState,
  prepareWarehouseStateRestore,
  prunedCycleCountDrafts,
  sanitizedLegacyWarehouseState,
} from "../lib/warehouse-state-normalization.ts";

function state(overrides = {}) {
  return {
    schemaVersion: 4,
    items: [],
    posts: [],
    docs: [],
    extIssues: [],
    stockTransfers: [],
    inventoryActs: [],
    auditLog: [],
    notifications: [],
    notificationSeq: 0,
    documentSeq: { defekt: 99, work: 199 },
    ...overrides,
  };
}

const unusedItem = {
  id: "item-delete",
  name: "Тестовый товар",
  sku: "DELETE-001",
  unit: "шт",
  stock: 0,
  ext: 0,
  posts: {},
  lots: [],
};

test("shared state normalization removes legacy scalar rows without mutating the source", () => {
  const item = { id: "item-valid", name: "Исправный товар" };
  const act = { id: "act-valid", no: "ИНВ-000001" };
  const source = state({
    items: [item, "junk", null, 42, []],
    inventoryActs: [act, "junk", null],
    accounts: [{ id: "forged-owner" }],
    currentRole: "admin",
  });
  const normalized = normalizedWarehouseState(source);
  assert.ok(normalized);
  assert.deepEqual(normalized.items, [item]);
  assert.deepEqual(normalized.inventoryActs, [act]);
  assert.equal("accounts" in normalized, false);
  assert.equal("currentRole" in normalized, false);
  assert.equal(source.items.length, 5, "normalization must not mutate the caller's arrays");
});

test("schema v4 migrates the built-in Расход category and its existing cards to Расходники", () => {
  const normalized = normalizedWarehouseState(state({
    categoriesList: ["ФПВ", "Расход", "Расходники"],
    items: [
      { id: "old-consumable", topCat: "Расход" },
      { id: "component", topCat: "Комплектующие", subCat: "Расходники" },
    ],
  }));
  assert.ok(normalized);
  assert.equal(normalized.schemaVersion, CURRENT_WAREHOUSE_SCHEMA_VERSION);
  assert.deepEqual(normalized.categoriesList, ["ФПВ", "Расходники"]);
  assert.equal(normalized.items[0].topCat, "Расходники");
  assert.equal(normalized.items[1].topCat, "Комплектующие");
});

test("worker merge accepts a new assigned-post defect without exposing or changing warehouse stock", () => {
  const previous = state({
    items: [{
      id: "repair-item",
      name: "Изделие",
      sku: "R-1",
      unit: "шт",
      stock: 10,
      ext: 0,
      lots: [{ lot: "warehouse", qty: 10 }],
      posts: { "ТЭЧ": 2, "НРТК": 4 },
      history: [{ id: "old-tech", post: "ТЭЧ", text: "Старое движение" }],
    }],
    posts: [
      { name: "ТЭЧ", stock: [{ id: "repair-item", q: 2 }], repairs: [] },
      { name: "НРТК", stock: [{ id: "repair-item", q: 4 }], repairs: [] },
    ],
  });
  const viewer = { id: "worker-1", role: "worker", assignment: "ТЭЧ" };
  const incoming = structuredClone(projectWarehouseStateForUser(previous, viewer));
  const defect = {
    id: "defect-worker-1",
    no: "ДФ-000001",
    kind: "defekt",
    status: "Закрыт",
    post: "ТЭЧ",
    item: "Изделие",
    itemId: "repair-item",
    orderNo: "З-1",
    callsign: "Линза",
    fault: "Не включается",
    verdict: "Ремонтопригодно",
    defects: ["Обрыв"],
    workDoc: null,
  };
  incoming.docs.unshift(defect);
  incoming.documentSeq.defekt += 1;
  incoming.notificationSeq += 2;
  incoming.items[0].posts["ТЭЧ"] = 3;
  incoming.items[0].history.push({ id: "new-tech", text: "Принято в ремонт", q: "+1 шт" });
  incoming.posts[0].stock[0].q = 3;
  incoming.posts[0].repairs.push({
    serial: "—",
    item: "Изделие",
    status: "В ремонте",
    doc: defect.no,
  });

  const merged = mergeWorkerPostState(previous, incoming, viewer);
  assert.equal(merged.issue, null);
  assert.ok(merged.state);
  assert.equal(merged.state.items[0].stock, 10);
  assert.deepEqual(merged.state.items[0].lots, [{ lot: "warehouse", qty: 10 }]);
  assert.deepEqual(merged.state.items[0].posts, { "ТЭЧ": 3, "НРТК": 4 });
  assert.equal(merged.state.items[0].history.at(-1).post, "ТЭЧ");
  assert.equal(merged.state.posts[1].stock[0].q, 4);
  assert.deepEqual(merged.state.documentSeq, { defekt: 100, work: 199 });
  assert.equal(merged.state.notificationSeq, 0);

  const forged = structuredClone(incoming);
  forged.items[0].stock = 1;
  assert.match(
    mergeWorkerPostState(previous, forged, viewer).issue?.error ?? "",
    /только документы своего поста|складскую карточку/,
  );
  const forgedSequence = structuredClone(incoming);
  forgedSequence.documentSeq.defekt += 50;
  assert.match(
    mergeWorkerPostState(previous, forgedSequence, viewer).issue?.error ?? "",
    /Счётчик документов/,
  );
});

test("worker merge accepts a linked work-act draft for an existing closed defect", () => {
  const defect = {
    id: "defect-existing",
    no: "ДФ-000010",
    kind: "defekt",
    status: "Закрыт",
    post: "ТЭЧ",
    item: "Изделие",
    orderNo: "З-10",
    callsign: "Линза",
    fault: "Не включается",
    verdict: "Ремонтопригодно",
    defects: ["Обрыв"],
    workDoc: null,
  };
  const previous = state({
    posts: [{ name: "ТЭЧ", stock: [], repairs: [] }],
    docs: [defect],
  });
  const viewer = { id: "worker-1", role: "worker", assignment: "ТЭЧ" };
  const incoming = structuredClone(projectWarehouseStateForUser(previous, viewer));
  incoming.docs[0].workDoc = "АВР-000010";
  incoming.docs.unshift({
    id: "work-worker-1",
    no: "АВР-000010",
    kind: "work",
    status: "Черновик",
    post: "ТЭЧ",
    item: "Изделие",
    defektDoc: "ДФ-000010",
    works: [],
    materials: [],
    participants: [],
    actionTypes: [],
  });
  incoming.documentSeq.work += 1;
  incoming.notificationSeq += 1;
  const merged = mergeWorkerPostState(previous, incoming, viewer);
  assert.equal(merged.issue, null);
  assert.equal(merged.state?.docs[0].no, "АВР-000010");
  assert.equal(merged.state?.docs[1].workDoc, "АВР-000010");

  const forgedApproval = structuredClone(incoming);
  forgedApproval.docs[0].status = "Ожидает приёмки на склад";
  forgedApproval.docs[0].approvedBy = "Поддельный администратор";
  assert.match(
    mergeWorkerPostState(previous, forgedApproval, viewer).issue?.error ?? "",
    /должен быть черновиком|Согласование акта выполняет только администратор|служебные поля/,
  );
});

test("legacy archive sanitation accepts missing schema and prunes drafts per account", () => {
  const validDraft = {
    id: "draft-valid",
    startedAt: "2026-07-27T10:00:00.000Z",
    actor: { id: "owner-1", role: "owner" },
    itemIds: ["item-valid"],
    positions: 1,
    books: { "item-valid": 2 },
    counts: { "item-valid": 1 },
  };
  const archive = state({
    items: [{ id: "item-valid" }, "junk"],
    cycleCountDrafts: {
      "owner-1": validDraft,
      broken: { actor: { id: "someone-else" }, itemIds: [], books: {}, counts: {} },
    },
  });
  delete archive.schemaVersion;
  const sanitized = sanitizedLegacyWarehouseState(archive);
  assert.ok(sanitized);
  assert.equal(sanitized.schemaVersion, CURRENT_WAREHOUSE_SCHEMA_VERSION);
  assert.deepEqual(sanitized.items, [{ id: "item-valid" }]);
  assert.deepEqual(sanitized.cycleCountDrafts, { "owner-1": validDraft });
  assert.deepEqual(prunedCycleCountDrafts(archive.cycleCountDrafts), { "owner-1": validDraft });
  assert.deepEqual(
    prunedCycleCountDrafts({
      ...Object.fromEntries(Array.from({ length: 101 }, (_, index) => [
        `broken-${index}`,
        { ...validDraft, actor: { id: "someone-else", role: "worker" } },
      ])),
      "owner-1": validDraft,
    }),
    { "owner-1": validDraft },
    "invalid rows before a valid draft must not consume the 100-account output limit",
  );
});

test("restore preparation tolerates broken current state and reports discarded drafts", () => {
  const archive = state({ items: [{ id: "item-valid" }] });
  const prepared = prepareWarehouseStateRestore(archive, { broken: true });
  assert.ok(prepared);
  assert.equal(prepared.currentStateDamaged, true);
  assert.equal(prepared.legacySchemaAdjusted, false);
  assert.deepEqual(prepared.state.cycleCountDrafts, {});
  assert.equal(
    prepareWarehouseStateRestore({ ...archive, items: "broken" }, state()),
    null,
    "an archive without the required structural arrays must still be rejected",
  );
});

test("restore preparation keeps valid current drafts and reports only invalid rows", () => {
  const validDraft = {
    id: "draft-owner",
    startedAt: "2026-07-27T10:00:00.000Z",
    actor: { id: "owner-1", role: "owner" },
    itemIds: [],
    positions: 0,
    books: {},
    counts: {},
  };
  const prepared = prepareWarehouseStateRestore(
    state({ items: [{ id: "archived-item" }] }),
    state({
      cycleCountDrafts: {
        "owner-1": validDraft,
        "broken-user": { ...validDraft, actor: { id: "someone-else", role: "worker" } },
      },
    }),
  );
  assert.ok(prepared);
  assert.equal(prepared.currentStateDamaged, false);
  assert.equal(prepared.discardedCurrentDrafts, 1);
  assert.deepEqual(prepared.state.cycleCountDrafts, { "owner-1": validDraft });
});

test("server deletion policy rejects a storekeeper and allows an admin for an unused card", () => {
  const previous = state({ items: [unusedItem] });
  const next = state();
  assert.deepEqual(warehouseDeletionPolicy(previous, next, "storekeeper"), {
    status: 403,
    error: "Удалять карточки товара может только владелец или администратор",
  });
  assert.equal(warehouseDeletionPolicy(previous, next, "admin"), null);
  assert.equal(warehouseDeletionPolicy(previous, next, "owner"), null);
});

test("server deletion policy rejects cards with warehouse, post, lot or external balances", () => {
  for (const item of [
    { ...unusedItem, stock: 1 },
    { ...unusedItem, ext: 1 },
    { ...unusedItem, posts: { "ТЭЧ": 1 } },
    { ...unusedItem, lots: [{ lot: "A", qty: 1 }] },
  ]) {
    const previous = state({ items: [item] });
    const result = warehouseDeletionPolicy(previous, state(), "admin");
    assert.equal(result?.status, 409);
  }
  const postState = state({
    items: [unusedItem],
    posts: [{ name: "ТЭЧ", stock: [{ id: unusedItem.id, q: 1 }] }],
  });
  assert.equal(warehouseDeletionPolicy(postState, state(), "owner")?.status, 409);
});

test("server deletion policy rejects document and external-issue references", () => {
  const documentState = state({
    items: [unusedItem],
    docs: [{ no: "АВР-1", materials: [{ id: unusedItem.id, q: 1 }] }],
  });
  const issueState = state({
    items: [unusedItem],
    extIssues: [{ no: "ВН-1", items: [{ id: unusedItem.id, q: 1 }] }],
  });
  assert.match(warehouseItemDeletionIssue(documentState, unusedItem.id), /документ/);
  assert.match(warehouseItemDeletionIssue(issueState, unusedItem.id), /выдач/);
  assert.equal(warehouseDeletionPolicy(documentState, state(), "admin")?.status, 409);
  assert.equal(warehouseDeletionPolicy(issueState, state(), "owner")?.status, 409);
});

test("closed documents and returned external issues preserve history without locking the card forever", () => {
  const historical = state({
    items: [unusedItem],
    docs: [{
      no: "АВР-OLD",
      status: "Закрыт",
      itemId: unusedItem.id,
      materials: [{ id: unusedItem.id, q: 1 }],
    }],
    extIssues: [{ no: "ВН-OLD", status: "Возвращено", items: [{ id: unusedItem.id, q: 1 }] }],
  });
  assert.equal(warehouseItemDeletionIssue(historical, unusedItem.id), null);
  assert.equal(warehouseDeletionPolicy(historical, state(), "admin")?.status, 409);
  const archived = removeWarehouseItemFromState(historical, unusedItem.id);
  assert.equal(warehouseDeletionPolicy(historical, archived, "admin"), null);
  assert.equal(archived.docs[0].materials[0].name, unusedItem.name);
  assert.equal(archived.extIssues[0].items[0].sku, unusedItem.sku);
});

test("product endpoint matches shared-state cards only by immutable id", () => {
  const snapshot = state({ items: [unusedItem] });
  assert.equal(findWarehouseItemId(snapshot, unusedItem.id), unusedItem.id);
  assert.equal(findWarehouseItemId(snapshot, "different-id"), "");
  assert.equal(findWarehouseItemId(snapshot, "missing"), "");
});

test("historical transfers and inventory acts retain product labels after card deletion", () => {
  const previous = state({
    items: [unusedItem],
    stockTransfers: [{ no: "ПМ-1", items: [{ id: unusedItem.id, q: 1 }] }],
    inventoryActs: [{ no: "ИНВ-1", diffs: [{ id: unusedItem.id, counted: 0 }] }],
    docs: [{ no: "АВР-1", status: "Закрыт", materials: [{ id: unusedItem.id, q: 1 }] }],
    extIssues: [{ no: "ВН-1", status: "Возвращено", items: [{ id: unusedItem.id, q: 1 }] }],
  });
  const unsafe = state({
    stockTransfers: previous.stockTransfers,
    inventoryActs: previous.inventoryActs,
  });
  assert.equal(warehouseDeletionPolicy(previous, unsafe, "admin")?.status, 409);

  const archived = removeWarehouseItemFromState(previous, unusedItem.id);
  assert.equal(warehouseDeletionPolicy(previous, archived, "admin"), null);
  assert.deepEqual(archived.stockTransfers[0].items[0], {
    id: unusedItem.id,
    q: 1,
    name: unusedItem.name,
    sku: unusedItem.sku,
    unit: unusedItem.unit,
  });
  assert.equal(archived.inventoryActs[0].diffs[0].name, unusedItem.name);
  assert.equal(archived.docs[0].materials[0].unit, unusedItem.unit);
  assert.equal(archived.extIssues[0].items[0].name, unusedItem.name);
  assert.equal(archived.items.length, 0);
});

test("history removal and missing archive metadata return distinct deletion errors", () => {
  const previous = state({
    items: [unusedItem],
    stockTransfers: [{ no: "ПМ-OLD", items: [{ id: unusedItem.id, q: 1 }] }],
  });
  const removedHistory = state({ items: [] });
  assert.match(
    warehouseDeletionPolicy(previous, removedHistory, "admin")?.error ?? "",
    /удалением связанной истории/,
  );
  const metadataMissing = state({
    items: [],
    stockTransfers: [{ no: "ПМ-OLD", items: [{ id: unusedItem.id, q: 1 }] }],
  });
  assert.match(
    warehouseDeletionPolicy(previous, metadataMissing, "admin")?.error ?? "",
    /отсутствует архивное название/,
  );
});

test("storekeeper may advance documents but cannot erase warehouse history", () => {
  const previous = state({
    docs: [{ no: "АВР-1", status: "На согласовании", post: "ТЭЧ" }],
    extIssues: [{ no: "ВН-1", status: "Выдано", post: "ТЭЧ" }],
    stockTransfers: [{ no: "ПМ-1", post: "ТЭЧ", items: [] }],
    inventoryActs: [{ id: "inventory-signed-1", no: "ИНВ-1", diffs: [] }],
    auditLog: [{ id: "audit-1", action: "Выдача", post: "ТЭЧ" }],
  });
  const advanced = state({
    docs: [{ ...previous.docs[0], status: "Ожидает приёмки на склад" }],
    extIssues: [{ ...previous.extIssues[0], status: "Возвращено" }],
    stockTransfers: previous.stockTransfers,
    inventoryActs: previous.inventoryActs,
    auditLog: previous.auditLog,
  });
  assert.equal(warehouseHistoryMutationIssue(previous, advanced, "storekeeper"), null);
  assert.equal(warehouseHistoryMutationIssue(previous, state(), "storekeeper")?.status, 403);
  assert.equal(warehouseHistoryMutationIssue(previous, state(), "admin")?.status, 403);
  assert.equal(
    warehouseHistoryMutationIssue(previous, state(), "owner")?.status,
    403,
    "even the owner must not erase a server-signed inventory act",
  );
});

test("inventory acts may be appended but existing headers are immutable for every role", () => {
  const act = {
    id: "inventory-immutable",
    no: "ИНВ-000001",
    startedAt: "2026-07-27T10:00:00.000Z",
    finishedAt: "2026-07-27T10:05:00.000Z",
    actor: { id: "owner", name: "Owner", role: "owner" },
    totals: { positions: 1, matched: 1, mismatched: 0, surplus: 0, shortage: 0 },
    diffs: [],
  };
  const previous = state({ inventoryActs: [act] });
  const appended = state({ inventoryActs: [{ ...act, id: "inventory-next", no: "ИНВ-000002" }, act] });
  assert.equal(warehouseHistoryMutationIssue(previous, appended, "owner"), null);
  assert.equal(
    warehouseHistoryMutationIssue(previous, state({ inventoryActs: [{ ...act, no: "ПОДМЕНА" }] }), "owner")?.status,
    403,
  );
  assert.equal(warehouseHistoryMutationIssue(previous, state(), "owner")?.status, 403);
});

test("history comparison accepts schema defaults but rejects same-number replacement and field stripping", () => {
  const previous = state({
    docs: [{
      no: "АВР-7",
      kind: "work",
      status: "Черновик",
      post: "ТЭЧ",
      itemId: "item-7",
      materials: [{ id: "material-1", q: 1 }],
    }],
    stockTransfers: [{ no: "ПМ-7", post: "ТЭЧ", items: [] }],
  });
  const migrated = state({
    docs: [{ ...previous.docs[0], createdAt: 0, status: "Ожидает согласования" }],
    stockTransfers: [{ createdAt: 0, items: [], post: "ТЭЧ", no: "ПМ-7" }],
  });
  assert.equal(warehouseHistoryMutationIssue(previous, migrated, "storekeeper"), null);
  assert.equal(
    warehouseHistoryMutationIssue(previous, state({ docs: [{ no: "АВР-7" }], stockTransfers: previous.stockTransfers }), "storekeeper")?.status,
    403,
  );
  const reusedNumber = state({
    docs: [{
      ...previous.docs[0],
      post: "НРТК",
      itemId: "different-item",
    }],
    stockTransfers: previous.stockTransfers,
  });
  assert.equal(warehouseHistoryMutationIssue(previous, reusedNumber, "admin")?.status, 403);
});

test("rolling feeds only evict the oldest tail after newer rows are prepended", () => {
  const previousAudit = Array.from({ length: 2_000 }, (_, index) => ({
    id: `audit-${index}`,
    action: `event-${index}`,
  }));
  const previous = state({ auditLog: previousAudit });
  const validWindow = state({
    auditLog: [{ id: "audit-new", action: "new-event" }, ...previousAudit.slice(0, 1_999)],
  });
  assert.equal(warehouseHistoryMutationIssue(previous, validWindow, "admin"), null);

  const replacedMiddle = previousAudit.slice();
  replacedMiddle.splice(400, 1);
  replacedMiddle.unshift({ id: "audit-fabricated", action: "replacement" });
  assert.equal(warehouseHistoryMutationIssue(
    previous,
    state({ auditLog: replacedMiddle.slice(0, 2_000) }),
    "admin",
  )?.status, 403);

  const shortPrevious = state({ auditLog: previousAudit.slice(0, 10) });
  const shortReplacement = state({
    auditLog: [{ id: "audit-new", action: "new-event" }, ...previousAudit.slice(0, 9)],
  });
  assert.equal(warehouseHistoryMutationIssue(shortPrevious, shortReplacement, "admin")?.status, 403);

  const floodedWindow = [
    ...Array.from({ length: 1_999 }, (_, index) => ({
      id: `fabricated-${index}`,
      action: "noise",
    })),
    previousAudit[0],
  ];
  assert.equal(
    warehouseHistoryMutationIssue(previous, state({ auditLog: floodedWindow }), "admin")?.status,
    403,
    "one write cannot erase a full audit window by fabricating 1999 rows",
  );

  const legitimateOfflineBatch = [
    ...Array.from({ length: 201 }, (_, index) => ({
      id: `offline-${index}`,
      action: "offline-event",
    })),
    ...previousAudit.slice(0, 1_799),
  ];
  const overflow = warehouseHistoryMutationIssue(
    previous,
    state({ auditLog: legitimateOfflineBatch }),
    "admin",
  );
  assert.equal(overflow?.status, 403);
  assert.match(overflow?.error ?? "", /не более 200 новых записей журнала/);
});

test("notification read state is mutable without allowing notification content edits", () => {
  const notification = {
    id: "notification-1",
    title: "Новый акт",
    text: "Создан акт дефектовки",
    read: false,
  };
  const previous = state({ notifications: [notification] });
  assert.equal(
    warehouseHistoryMutationIssue(
      previous,
      state({ notifications: [{ ...notification, read: true }] }),
      "storekeeper",
    ),
    null,
  );
  assert.equal(
    warehouseHistoryMutationIssue(
      previous,
      state({ notifications: [{ ...notification, text: "Подменённый текст", read: true }] }),
      "admin",
    )?.status,
    403,
  );
  assert.equal(
    warehouseHistoryMutationIssue(
      previous,
      state({
        notifications: [
          ...Array.from({ length: 201 }, (_, index) => ({
            id: `notification-new-${index}`,
            text: "noise",
            read: false,
          })),
          notification,
        ],
      }),
      "admin",
    )?.status,
    403,
    "a single snapshot cannot prepend an unbounded notification flood",
  );
});

test("worker state projection contains only the assigned post slice", () => {
  const full = state({
    items: [{
      id: "item-1",
      stock: 100,
      ext: 4,
      lots: [{ q: 100 }],
      posts: { "ТЭЧ": 2, "НРТК": 8 },
      history: [{ post: "ТЭЧ", q: 2 }, { post: "НРТК", q: 8 }],
    }],
    posts: [{ name: "ТЭЧ" }, { name: "НРТК" }],
    docs: [{ no: "ДФ-1", post: "ТЭЧ" }, { no: "ДФ-2", post: "НРТК" }],
    extIssues: [{ no: "ВН-1", post: "ТЭЧ" }, { no: "ВН-2", post: "НРТК" }],
    stockTransfers: [{ no: "ПМ-1", post: "ТЭЧ" }, { no: "ПМ-2", post: "НРТК" }],
    inventoryActs: [{ no: "ИНВ-1" }],
    auditLog: [{ id: "a-1", post: "ТЭЧ" }, { id: "a-2", post: "НРТК" }],
    notifications: [{ id: "n-1", post: "ТЭЧ" }, { id: "n-2", post: "НРТК" }],
  });
  const projected = projectWarehouseStateForUser(full, { role: "worker", assignment: " ТЭЧ " });
  assert.deepEqual(projected.posts.map((entry) => entry.name), ["ТЭЧ"]);
  assert.deepEqual(projected.docs.map((entry) => entry.no), ["ДФ-1"]);
  assert.deepEqual(projected.extIssues.map((entry) => entry.no), ["ВН-1"]);
  assert.deepEqual(projected.stockTransfers.map((entry) => entry.no), ["ПМ-1"]);
  assert.deepEqual(projected.auditLog.map((entry) => entry.id), ["a-1"]);
  assert.deepEqual(projected.notifications.map((entry) => entry.id), ["n-1"]);
  assert.deepEqual(projected.inventoryActs, []);
  assert.equal(projected.items[0].stock, 0);
  assert.deepEqual(projected.items[0].posts, { "ТЭЧ": 2 });
  assert.equal(full.items[0].stock, 100, "projection must not mutate server truth");

  const unassigned = projectWarehouseStateForUser(full, { role: "worker", assignment: "   " });
  assert.deepEqual(unassigned.posts, []);
  assert.deepEqual(unassigned.docs, []);
  assert.deepEqual(unassigned.auditLog, []);
  assert.deepEqual(unassigned.items[0].posts, {});
});
