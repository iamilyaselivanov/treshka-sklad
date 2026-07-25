import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const text = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("release version is 1.6 in web and Android", async () => {
  const [pkg, page, gradle] = await Promise.all([
    text("package.json"),
    text("app/page.tsx"),
    text("android/app/build.gradle"),
  ]);
  assert.equal(JSON.parse(pkg).version, "1.6.0");
  assert.match(page, /Версия 1\.6/);
  assert.match(gradle, /versionCode 8/);
  assert.match(gradle, /versionName "1\.6"/);
});

test("security endpoints and server-connected APK are present", async () => {
  const paths = [
    "app/api/auth/setup/route.ts",
    "app/api/auth/password/route.ts",
    "app/api/auth/recover-owner/route.ts",
    "app/api/users/transfer-owner/route.ts",
    "app/api/audit/route.ts",
    "app/api/media/images/route.ts",
  ];
  await Promise.all(paths.map(text));
  const activity = await text("android/app/src/main/java/com/treshka/sklad/MainActivity.kt");
  assert.match(activity, /https:\/\/sklad-ok-prototype\.janfoody2016\.chatgpt\.site\//);
  assert.match(activity, /WebView/);
});

test("server release keeps the complete warehouse interface and prescribed posts", async () => {
  const [page, prototype, stateRoute] = await Promise.all([
    text("app/page.tsx"),
    text("public/prototype.html"),
    text("app/api/state/route.ts"),
  ]);
  assert.match(page, /prototype\.html\?server=1/);
  assert.match(prototype, />Посты</);
  assert.match(prototype, />Документы</);
  assert.match(prototype, /Акт дефектовки/);
  assert.match(prototype, /Акт выполненных работ/);
  for (const post of ["ТЭЧ", "НРТК", "FPV радио", "3D печать", "Разработки ПО", "Намотки оптоволокна"]) {
    assert.match(prototype, new RegExp(post));
  }
  assert.match(stateRoute, /warehouse_full_state/);
  assert.match(stateRoute, /MAX_STATE_BYTES/);
  assert.match(stateRoute, /expectedRevision/);
  assert.match(stateRoute, /currentRevision/);
});

test("secrets are runtime environment variables, never embedded values", async () => {
  const [setup, recovery] = await Promise.all([
    text("app/api/auth/setup/route.ts"),
    text("app/api/auth/recover-owner/route.ts"),
  ]);
  assert.match(setup, /INITIAL_SETUP_CODE/);
  assert.match(recovery, /OWNER_RECOVERY_CODE/);
  assert.doesNotMatch(`${setup}\n${recovery}`, /github_pat_/);
});

test("server accounts support permanent-password creation and protected deletion", async () => {
  const [usersRoute, bridge, stateRoute] = await Promise.all([
    text("app/api/users/route.ts"),
    text("public/prototype-server.js"),
    text("app/api/state/route.ts"),
  ]);
  assert.match(usersRoute, /export async function DELETE/);
  assert.match(usersRoute, /DELETE FROM users/);
  assert.match(bridge, /password\.length < 8/);
  assert.match(bridge, /method: "POST"/);
  assert.match(bridge, /method: "DELETE"/);
  assert.match(bridge, /window\.requestRoleSwitch/);
  assert.match(stateRoute, /user: auth\.user/);
  assert.doesNotMatch(bridge, /fetch\("\/api\/auth\/status"/);
});

test("security hardening keeps state writes privileged and recovery throttling global", async () => {
  const [stateRoute, recoveryRoute, auth, productsRoute, migration] = await Promise.all([
    text("app/api/state/route.ts"),
    text("app/api/auth/recover-owner/route.ts"),
    text("lib/auth.ts"),
    text("app/api/products/route.ts"),
    text("drizzle/0003_warehouse_full_state.sql"),
  ]);
  assert.match(stateRoute, /requireUser\(request, \["owner", "admin", "storekeeper"\]\)/);
  assert.match(stateRoute, /warehouseDeletionPolicy\(previous, state, auth\.user\.role\)/);
  assert.match(stateRoute, /terminal: true, recover: "server"/);
  assert.match(stateRoute, /SELECT revision, item_ids, updated_at, updated_by/);
  assert.match(productsRoute, /requireUser\(request, \["owner", "admin"\]\)/);
  assert.match(stateRoute, /"state_updated"/);
  assert.doesNotMatch(stateRoute, /revision % 25/);
  assert.match(recoveryRoute, /clientThrottleKey\(request, "recovery-owner"\)/);
  assert.doesNotMatch(recoveryRoute, /clientThrottleKey\(request, "recovery", login\)/);
  assert.match(auth, /failures = login_throttle\.failures \+ 1/);
  assert.match(auth, /DELETE FROM login_throttle WHERE login = \? AND last_attempt_at = \?/);
  assert.match(auth, /fetchSite !== "same-origin" && fetchSite !== "none"/);
  assert.match(auth, /drained >= 8_192/);
  assert.doesNotMatch(`${auth}\n${stateRoute}\n${productsRoute}`, /CREATE TABLE IF NOT EXISTS/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `warehouse_full_state`/);
});

test("sync hardening keeps conflicts recoverable and Android secrets protected", async () => {
  const [browserSync, androidStore, androidSync, activity, manifest, extractionRules] = await Promise.all([
    text("public/prototype-server.js"),
    text("android/app/src/main/java/com/treshka/sklad/AppStateStore.kt"),
    text("android/app/src/main/java/com/treshka/sklad/ServerSyncManager.kt"),
    text("android/app/src/main/java/com/treshka/sklad/MainActivity.kt"),
    text("android/app/src/main/AndroidManifest.xml"),
    text("android/app/src/main/res/xml/data_extraction_rules.xml"),
  ]);
  assert.match(browserSync, /fetchWithTimeout/);
  assert.match(browserSync, /noteSyncFailure/);
  assert.match(browserSync, /sync\.conflict = true;\s*sync\.pendingRemote = snapshot;/);
  assert.match(browserSync, /Серверная версия повреждена\. Локальные данные сохранены/);
  assert.match(browserSync, /function canUploadState\(\)/);
  assert.match(browserSync, /if \(!canUploadState\(\)\) \{\s*await pollServer\(\);\s*return;/);
  assert.match(browserSync, /canUploadState\(\) && localPayload !== sync\.lastUploaded/);
  assert.match(browserSync, /sync\.conflict \|\| !canUploadState\(\)/);
  assert.match(androidStore, /SyncTokenVault/);
  assert.match(androidStore, /AndroidKeyStore/);
  assert.match(androidStore, /DB_VERSION = 4/);
  assert.match(androidStore, /conflict INTEGER NOT NULL DEFAULT 0/);
  assert.match(androidStore, /fun claimNextPending\(\)/);
  assert.match(androidStore, /UPDATE sync_outbox SET attempts=\? WHERE mutation_id=\? AND conflict=0/);
  assert.match(androidStore, /db\.delete\("sync_outbox", "attempts = 0 AND conflict = 0"/);
  assert.doesNotMatch(androidStore, /fun markMutationAttempted\(/);
  assert.match(androidSync, /store\.markMutationConflicted\(pending\.mutationId, message\)/);
  assert.match(androidSync, /store\.sendablePendingCount\(\) == 0/);
  assert.match(androidSync, /store\.savePendingRemoteSnapshot\(payload, revision\)/);
  assert.match(androidSync, /store\.discardConflictedMutation\(id\)/);
  assert.match(androidSync, /store\.requeueConflictedMutation\(id\)/);
  assert.match(androidSync, /val retryable = response\.code == 408/);
  assert.match(androidSync, /store\.markMutationConflicted\(pending\.mutationId, message\)/);
  assert.doesNotMatch(androidSync, /scheduleRetry\(pending\.attempts, pending\.mutationId\)/);
  assert.doesNotMatch(androidStore, /releaseConflictedMutations/);
  assert.match(browserSync, /adoptServerUser\(data\.user\)/);
  assert.match(browserSync, /Локальное изменение отменено/);
  assert.match(activity, /uri\.host != APP_HOST/);
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(manifest, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
  assert.match(extractionRules, /<exclude domain="root" path="\." \/>/);
});

test("build and local D1 bootstrap use the packaged Drizzle migrations", async () => {
  const [pkg, vite, plugin, wrangler] = await Promise.all([
    text("package.json"),
    text("vite.config.ts"),
    text("build/sites-vite-plugin.ts"),
    text("dist/server/wrangler.json"),
  ]);
  assert.match(JSON.parse(pkg).scripts["db:migrate:local"], /wrangler d1 migrations apply DB --local --persist-to \.wrangler\/state/);
  assert.match(vite, /migrations_dir: "\.\/drizzle"/);
  assert.match(plugin, /resolve\(root, "drizzle"\)/);
  assert.equal(JSON.parse(wrangler).d1_databases[0].migrations_dir, "../../drizzle");
  await text("dist/.openai/drizzle/0000_unique_vampiro.sql");
  await text("dist/.openai/drizzle/0001_famous_the_hunter.sql");
  await text("dist/.openai/drizzle/0002_quick_bloodscream.sql");
  await text("dist/.openai/drizzle/0003_warehouse_full_state.sql");
  await text("dist/.openai/drizzle/0004_pale_thanos.sql");
  await text("dist/.openai/drizzle/0005_hard_moira_mactaggert.sql");
});

test("database migrations build a clean schema and adopt the legacy runtime state table", async () => {
  const migrations = await Promise.all([
    text("drizzle/0000_unique_vampiro.sql"),
    text("drizzle/0001_famous_the_hunter.sql"),
    text("drizzle/0002_quick_bloodscream.sql"),
    text("drizzle/0003_warehouse_full_state.sql"),
    text("drizzle/0004_pale_thanos.sql"),
    text("drizzle/0005_hard_moira_mactaggert.sql"),
  ]);
  const apply = (database, sql) => {
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) database.exec(statement);
    }
  };

  const clean = new DatabaseSync(":memory:");
  for (const migration of migrations) apply(clean, migration);
  for (const migration of migrations.slice(0, 3)) apply(clean, migration);
  assert.deepEqual(
    clean.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map((row) => row.name),
    ["audit_log", "login_throttle", "products", "push_deliveries", "push_devices", "push_events", "sessions", "users", "warehouse_full_state"],
  );
  clean.close();

  const adopted = new DatabaseSync(":memory:");
  for (const migration of migrations.slice(0, 3)) apply(adopted, migration);
  adopted.exec(`
    CREATE TABLE warehouse_full_state (
      state_key TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );
    INSERT INTO warehouse_full_state (state_key, revision, payload, updated_at, updated_by)
    VALUES ('main', 4, '{"items":[{"id":"legacy-item"}]}', '2026-07-25', 'legacy')
  `);
  apply(adopted, migrations[3]);
  assert.equal(
    adopted.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('warehouse_full_state')").get().count,
    5,
  );
  adopted.exec(`
    CREATE TABLE push_deliveries (
      id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL, user_id TEXT NOT NULL,
      device_id TEXT NOT NULL, status TEXT NOT NULL, provider_message_id TEXT DEFAULT '' NOT NULL,
      error TEXT DEFAULT '' NOT NULL, attempted_at TEXT
    );
    CREATE TABLE push_devices (
      id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
      token TEXT NOT NULL, platform TEXT DEFAULT 'android' NOT NULL,
      app_version TEXT DEFAULT '' NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
    );
    CREATE TABLE push_events (
      id TEXT PRIMARY KEY NOT NULL, actor_user_id TEXT NOT NULL, event_type TEXT NOT NULL,
      post TEXT DEFAULT '' NOT NULL, entity_no TEXT DEFAULT '' NOT NULL,
      summary TEXT DEFAULT '' NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO push_events
      (id, actor_user_id, event_type, post, entity_no, summary, title, body, created_at)
    VALUES ('legacy-event', 'owner', 'work_act_created', 'ТЭЧ', 'АВР-1', '', 'Акт', 'Тест', '2026-07-25');
  `);
  apply(adopted, migrations[4]);
  assert.equal(
    adopted.prepare("SELECT COUNT(*) AS count FROM push_events WHERE id='legacy-event'").get().count,
    1,
  );
  apply(adopted, migrations[5]);
  assert.deepEqual(
    adopted.prepare("SELECT name FROM pragma_table_info('warehouse_full_state') WHERE name='item_ids'").all()
      .map((row) => row.name),
    ["item_ids"],
  );
  assert.deepEqual(
    adopted.prepare("SELECT name FROM pragma_table_info('push_deliveries') WHERE name='attempts'").all()
      .map((row) => row.name),
    ["attempts"],
  );
  assert.deepEqual(
    JSON.parse(adopted.prepare("SELECT item_ids AS itemIds FROM warehouse_full_state WHERE state_key='main'").get().itemIds),
    ["legacy-item"],
  );
  adopted.close();
});

test("push notifications are server-addressed, durable and connected to Android FCM", async () => {
  const [eventsRoute, pushEvents, devicesRoute, fcm, bridge, prototype, service, activity, migration] = await Promise.all([
    text("app/api/notifications/events/route.ts"),
    text("lib/push-events.ts"),
    text("app/api/devices/register/route.ts"),
    text("lib/fcm.ts"),
    text("public/prototype-server.js"),
    text("public/prototype.html"),
    text("android/app/src/main/java/com/treshka/sklad/WarehouseFirebaseMessagingService.kt"),
    text("android/app/src/main/java/com/treshka/sklad/MainActivity.kt"),
    text("drizzle/0004_pale_thanos.sql"),
  ]);
  for (const eventType of [
    "post_stock_issued",
    "post_stock_returned",
    "defect_act_created",
    "work_act_created",
    "work_awaiting_warehouse",
    "storekeeper_post_issue_completed",
    "storekeeper_warehouse_return_accepted",
  ]) {
    assert.match(pushEvents, new RegExp(eventType));
    assert.match(prototype, new RegExp(eventType));
  }
  assert.match(pushEvents, /normalizePostAssignment/);
  assert.match(pushEvents, /'owner', 'admin', 'storekeeper'/);
  assert.match(pushEvents, /'owner', 'admin'/);
  assert.match(devicesRoute, /ON CONFLICT\(device_id\) DO UPDATE/);
  assert.match(devicesRoute, /MAX_DEVICES_PER_USER = 8/);
  assert.match(devicesRoute, /ORDER BY last_seen_at ASC/);
  assert.match(devicesRoute, /evictedOldest/);
  assert.match(eventsRoute, /responseBody\.failed > 0 \|\| responseBody\.disabled > 0/);
  assert.match(eventsRoute, /Promise\.all\(batch\.map/);
  assert.match(eventsRoute, /offset \+= 8/);
  assert.match(fcm, /firebase\.messaging/);
  assert.match(fcm, /fcm\.googleapis\.com\/v1\/projects/);
  assert.match(fcm, /pendingAccessToken/);
  assert.match(fcm, /response\.status === 401/);
  assert.match(fcm, /response\.status === 429 \|\| response\.status >= 500/);
  assert.match(bridge, /PUSH_QUEUE_KEY/);
  assert.match(bridge, /MAX_PUSH_QUEUE = 500/);
  assert.match(bridge, /nextAttemptAt/);
  assert.match(bridge, /push\.queue\.splice\(eventIndex, 1\);\s*push\.queue\.push\(event\)/);
  assert.doesNotMatch(bridge, /parsed\.filter\(\(entry\) => entry && entry\.actorUserId === sync\.user/);
  assert.match(bridge, /registerNativePush/);
  assert.match(service, /POST_NOTIFICATIONS/);
  assert.match(activity, /AndroidPush/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `push_devices`/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `push_events`/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `push_deliveries`/);
});
