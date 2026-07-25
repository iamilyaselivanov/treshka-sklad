import assert from "node:assert/strict";
import test from "node:test";
import {
  findWarehouseItemId,
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
  sku: "DELETE-001",
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

test("product endpoint can locate the shared-state card by immutable id or SKU", () => {
  const snapshot = state({ items: [unusedItem] });
  assert.equal(findWarehouseItemId(snapshot, unusedItem.id), unusedItem.id);
  assert.equal(findWarehouseItemId(snapshot, "different-id", unusedItem.sku), unusedItem.id);
  assert.equal(findWarehouseItemId(snapshot, "missing", "missing"), "");
});
