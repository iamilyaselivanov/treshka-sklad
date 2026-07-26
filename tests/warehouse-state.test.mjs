import assert from "node:assert/strict";
import test from "node:test";
import {
  findWarehouseItemId,
  projectWarehouseStateForUser,
  removeWarehouseItemFromState,
  warehouseDeletionPolicy,
  warehouseHistoryMutationIssue,
  warehouseItemDeletionIssue,
} from "../lib/warehouse-state.ts";

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
    inventoryActs: [{ no: "ИНВ-1", diffs: [] }],
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
  assert.equal(warehouseHistoryMutationIssue(previous, state(), "owner"), null);
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
