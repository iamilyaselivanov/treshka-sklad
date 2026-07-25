import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  PUSH_EVENT_TYPES,
  collectPushRecipients,
  pushActorAllowed,
  pushPresentation,
  pushRecipientQuery,
} from "../lib/push-events.ts";
import {
  PUSH_MAINTENANCE_SAMPLE_RATE,
  shouldRunPushMaintenance,
} from "../lib/push-maintenance.ts";

async function recipientDevices(database, type, post = "ТЭЧ", pageSize = 500) {
  const query = pushRecipientQuery(type);
  const statement = database.prepare(query.sql);
  const rows = await collectPushRecipients(
    (limit, offset) => statement.all(limit, offset),
    query.filterPost,
    post,
    pageSize,
  );
  return rows.map((row) => row.deviceId)
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

test("post stock notifications reach every active member of any role on that post and nobody else", async () => {
  const database = createRoutingDatabase();
  assert.deepEqual(await recipientDevices(database, "post_stock_issued"), [
    "device-admin-post",
    "device-store-post",
    "device-worker-1",
    "device-worker-2",
  ]);
  database.close();
});

test("acts, returns and warehouse acceptance reach owner, every admin and every storekeeper", async () => {
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
    assert.deepEqual(await recipientDevices(database, type), expected, type);
  }
  database.close();
});

test("storekeeper issue completion reaches owner and all administrators", async () => {
  const database = createRoutingDatabase();
  assert.deepEqual(await recipientDevices(database, "storekeeper_post_issue_completed"), [
    "device-admin-1",
    "device-admin-post",
    "device-owner",
    "device-owner-2",
  ]);
  database.close();
});

test("recipient pagination cannot drop post members after the former 2000-row boundary", async () => {
  const database = createRoutingDatabase();
  const insertUser = database.prepare(
    "INSERT INTO users (id, role, assignment, status) VALUES (?, 'worker', ?, 'active')",
  );
  const insertDevice = database.prepare(
    "INSERT INTO push_devices (user_id, device_id, token) VALUES (?, ?, ?)",
  );
  for (let index = 0; index < 2_050; index += 1) {
    const id = `bulk-${String(index).padStart(4, "0")}`;
    insertUser.run(id, index === 2_049 ? "ТЭЧ" : "Другой пост");
    insertDevice.run(id, `device-${id}`, `token-${id}`);
  }
  const recipients = await recipientDevices(database, "post_stock_issued", "  тЭч ", 137);
  assert.ok(recipients.includes("device-bulk-2049"));
  assert.ok(recipients.includes("device-worker-1"));
  assert.ok(!recipients.includes("device-bulk-2048"));
  database.close();
});

test("heavy push retention runs probabilistically instead of on every request", () => {
  assert.equal(PUSH_MAINTENANCE_SAMPLE_RATE, 64);
  assert.equal(shouldRunPushMaintenance(0), true);
  assert.equal(shouldRunPushMaintenance(64), true);
  assert.equal(shouldRunPushMaintenance(1), false);
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
