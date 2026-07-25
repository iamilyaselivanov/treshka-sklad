import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  PUSH_EVENT_TYPES,
  normalizePostAssignment,
  pushActorAllowed,
  pushPresentation,
  pushRecipientQuery,
} from "../lib/push-events.ts";

function recipientDevices(database, type, post = "ТЭЧ") {
  const query = pushRecipientQuery(type);
  const rows = database.prepare(query.sql).all();
  return rows
    .filter((row) =>
      !query.filterPost
      || normalizePostAssignment(row.assignment) === normalizePostAssignment(post))
    .map((row) => row.deviceId)
    .sort();
}

function createRoutingDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      assignment TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE push_devices (
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      token TEXT NOT NULL
    );
  `);
  const users = [
    ["owner", "owner", "", "active"],
    ["admin-1", "admin", "", "active"],
    ["admin-post", "admin", "ТЭЧ", "active"],
    ["store-1", "storekeeper", "", "active"],
    ["store-post", "storekeeper", "ТЭЧ", "active"],
    ["worker-1", "worker", "ТЭЧ", "active"],
    ["worker-2", "worker", "  тЭч  ", "active"],
    ["worker-other", "worker", "Связь", "active"],
    ["worker-inactive", "worker", "ТЭЧ", "disabled"],
  ];
  const insertUser = database.prepare(
    "INSERT INTO users (id, role, assignment, status) VALUES (?, ?, ?, ?)",
  );
  const insertDevice = database.prepare(
    "INSERT INTO push_devices (user_id, device_id, token) VALUES (?, ?, ?)",
  );
  for (const user of users) {
    insertUser.run(...user);
    insertDevice.run(user[0], `device-${user[0]}`, `token-${user[0]}`);
  }
  insertDevice.run("owner", "device-owner-2", "token-owner-2");
  return database;
}

test("post stock notifications reach every active member of that post and nobody else", () => {
  const database = createRoutingDatabase();
  assert.deepEqual(recipientDevices(database, "post_stock_issued"), [
    "device-worker-1",
    "device-worker-2",
  ]);
  database.close();
});

test("acts, returns and warehouse acceptance reach owner, every admin and every storekeeper", () => {
  const database = createRoutingDatabase();
  const expected = [
    "device-admin-1",
    "device-admin-post",
    "device-owner",
    "device-owner-2",
    "device-store-1",
    "device-store-post",
  ];
  for (const type of [
    "post_stock_returned",
    "defect_act_created",
    "work_act_created",
    "work_awaiting_warehouse",
    "storekeeper_warehouse_return_accepted",
  ]) {
    assert.deepEqual(recipientDevices(database, type), expected, type);
  }
  database.close();
});

test("storekeeper issue completion reaches owner and all administrators", () => {
  const database = createRoutingDatabase();
  assert.deepEqual(recipientDevices(database, "storekeeper_post_issue_completed"), [
    "device-admin-1",
    "device-admin-post",
    "device-owner",
    "device-owner-2",
  ]);
  database.close();
});

test("event actors and user-facing titles match the warehouse workflow", () => {
  assert.equal(PUSH_EVENT_TYPES.length, 7);
  assert.equal(pushActorAllowed("post_stock_issued", "worker"), false);
  assert.equal(pushActorAllowed("defect_act_created", "worker"), true);
  assert.equal(pushActorAllowed("work_awaiting_warehouse", "admin"), true);
  assert.equal(pushActorAllowed("work_awaiting_warehouse", "storekeeper"), false);
  assert.equal(pushActorAllowed("storekeeper_post_issue_completed", "storekeeper"), true);
  assert.equal(pushActorAllowed("storekeeper_post_issue_completed", "admin"), false);
  assert.match(
    pushPresentation("work_awaiting_warehouse", "ТЭЧ", "АВР-200", "").title,
    /ожидает приёмки/,
  );
  assert.match(
    pushPresentation("post_stock_returned", "ТЭЧ", "ПМ-1", "Антенна: 1 шт").body,
    /Антенна/,
  );
});
