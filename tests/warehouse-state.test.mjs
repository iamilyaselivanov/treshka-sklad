import assert from "node:assert/strict";
import test from "node:test";
import {
  findWarehouseItemId,
  removeWarehouseItemFromState,
  warehouseDeletionPolicy,
  warehouseItemDeletionIssue,
} from "../lib/warehouse-state.ts";

function state(overrides = {}) {
  return {
    schemaVersion: 4,
    items: [],
    posts: [],
    docs: [],
    extIssues: [],
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
    docs: [{ no: "АВР-OLD", status: "Закрыт", itemId: unusedItem.id }],
    extIssues: [{ no: "ВН-OLD", status: "Возвращено", items: [{ id: unusedItem.id, q: 1 }] }],
  });
  assert.equal(warehouseItemDeletionIssue(historical, unusedItem.id), null);
  assert.equal(warehouseDeletionPolicy(historical, state(), "admin"), null);
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
  assert.equal(archived.items.length, 0);
});
