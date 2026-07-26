import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  PUSH_EVENT_TYPES,
  PUSH_RECIPIENT_MAX_PAGES,
  collectPushRecipients,
  excludePreviouslyNotifiedDevices,
  normalizePostAssignment,
  pushActorAllowed,
  pushPresentation,
  pushRecipientQuery,
} from "../lib/push-events.ts";
import {
  PUSH_MAINTENANCE_INTERVAL_MS,
  claimPushMaintenance,
  maybeRunPushMaintenance,
} from "../lib/push-maintenance.ts";

async function recipientDevices(database, type, post = "ТЭЧ", pageSize = 500, actorUserId = "actor") {
  const query = pushRecipientQuery(type, post, actorUserId);
  const statement = database.prepare(query.sql);
  const rows = await collectPushRecipients(
    (limit, offset) => statement.all(...query.bindings, limit, offset),
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
      assignment_key TEXT NOT NULL,
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
    "INSERT INTO users (id, role, assignment, assignment_key, status) VALUES (?, ?, ?, ?, ?)",
  );
  const insertDevice = database.prepare(
    "INSERT INTO push_devices (user_id, device_id, token) VALUES (?, ?, ?)",
  );
  for (const user of users) {
    insertUser.run(user[0], user[1], user[2], normalizePostAssignment(user[2]), user[3]);
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

test("the actor never receives a duplicate push for their own action", async () => {
  const database = createRoutingDatabase();
  assert.deepEqual(
    await recipientDevices(database, "post_stock_issued", "ТЭЧ", 500, "store-post"),
    ["device-admin-post", "device-worker-1", "device-worker-2"],
  );
  assert.deepEqual(
    await recipientDevices(database, "storekeeper_post_issue_completed", "ТЭЧ", 500, "admin-post"),
    ["device-admin-1", "device-owner", "device-owner-2"],
  );
  database.close();
});

test("the management event does not duplicate a post notification on the same device", () => {
  assert.deepEqual(
    excludePreviouslyNotifiedDevices(
      [{ deviceId: "admin-post" }, { deviceId: "owner" }],
      ["admin-post"],
    ),
    [{ deviceId: "owner" }],
  );
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
    "INSERT INTO users (id, role, assignment, assignment_key, status) VALUES (?, 'worker', ?, ?, 'active')",
  );
  const insertDevice = database.prepare(
    "INSERT INTO push_devices (user_id, device_id, token) VALUES (?, ?, ?)",
  );
  for (let index = 0; index < 2_050; index += 1) {
    const id = `bulk-${String(index).padStart(4, "0")}`;
    insertUser.run(id, "ТЭЧ", normalizePostAssignment("ТЭЧ"));
    insertDevice.run(id, `device-${id}`, `token-${id}`);
  }
  const recipients = await recipientDevices(database, "post_stock_issued", "  тЭч ", 137);
  assert.ok(recipients.includes("device-bulk-2049"));
  assert.ok(recipients.includes("device-bulk-2048"));
  assert.ok(recipients.includes("device-worker-1"));
  assert.equal(recipients.filter((device) => device.startsWith("device-bulk-")).length, 2_050);
  database.close();
});

test("recipient pagination fails closed if a page source never terminates", async () => {
  let calls = 0;
  await assert.rejects(
    collectPushRecipients(() => {
      calls += 1;
      return [{ deviceId: `device-${calls}` }];
    }, 1),
    /pagination limit exceeded/,
  );
  assert.equal(calls, PUSH_RECIPIENT_MAX_PAGES + 1);
});

test("recipient pagination accepts exactly the configured maximum", async () => {
  let calls = 0;
  const expected = Array.from(
    { length: PUSH_RECIPIENT_MAX_PAGES },
    (_, index) => ({ deviceId: `device-${index}` }),
  );
  const recipients = await collectPushRecipients((limit, offset) => {
    calls += 1;
    return expected.slice(offset, offset + limit);
  }, 1);
  assert.deepEqual(recipients, expected);
  assert.equal(calls, PUSH_RECIPIENT_MAX_PAGES + 1);
});

test("assignment normalization matches migration whitespace rules", () => {
  assert.equal(
    normalizePostAssignment(`\tТЭЧ\u00a0${" ".repeat(40)}1\r\n`),
    "тэч 1",
  );
  assert.equal(
    normalizePostAssignment("\u202fÉЛЕКТРО\u202f"),
    "\u202fÉлектро\u202f",
    "characters SQLite does not transform must also remain untouched in JavaScript",
  );
});

test("heavy push retention is claimed predictably once per day", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE push_maintenance_state (id INTEGER PRIMARY KEY, last_run_at TEXT NOT NULL)");
  const d1 = {
    prepare(sql) {
      const statement = database.prepare(sql);
      let values = [];
      return {
        bind(...args) {
          values = args;
          return this;
        },
        async run() {
          const result = statement.run(...values);
          return { meta: { changes: Number(result.changes) } };
        },
      };
    },
  };
  const first = new Date("2026-07-26T00:00:00.000Z");
  assert.equal(PUSH_MAINTENANCE_INTERVAL_MS, 86_400_000);
  assert.equal(await claimPushMaintenance(d1, first), true);
  assert.equal(await claimPushMaintenance(d1, new Date(first.getTime() + 60_000)), false);
  assert.equal(
    await claimPushMaintenance(d1, new Date(first.getTime() + PUSH_MAINTENANCE_INTERVAL_MS + 1)),
    true,
  );
  database.close();
});

test("failed push maintenance releases its daily claim for retry", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE push_maintenance_state (id INTEGER PRIMARY KEY, last_run_at TEXT NOT NULL)");
  let shouldFail = true;
  const d1 = {
    prepare(sql) {
      if (sql.trimStart().startsWith("DELETE ")) {
        return { bind() { return this; } };
      }
      const statement = database.prepare(sql);
      let values = [];
      return {
        bind(...args) {
          values = args;
          return this;
        },
        async run() {
          const result = statement.run(...values);
          return { meta: { changes: Number(result.changes) } };
        },
      };
    },
    async batch() {
      if (shouldFail) throw new Error("simulated retention failure");
      return [];
    },
  };
  const now = new Date("2026-07-26T12:00:00.000Z");
  await assert.rejects(maybeRunPushMaintenance(d1, now), /simulated retention failure/);
  assert.equal(await claimPushMaintenance(d1, now), true);
  // Release the manual claim by advancing beyond the interval, then prove the
  // successful path retains the slot.
  shouldFail = false;
  const later = new Date(now.getTime() + PUSH_MAINTENANCE_INTERVAL_MS + 1);
  assert.equal(await maybeRunPushMaintenance(d1, later), true);
  assert.equal(await claimPushMaintenance(d1, new Date(later.getTime() + 1)), false);
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
