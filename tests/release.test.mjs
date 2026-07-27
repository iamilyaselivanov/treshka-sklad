import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  STATE_HISTORY_CAP_SQL,
  STATE_HISTORY_MAX_ROWS,
  STATE_HISTORY_PRUNE_SQL,
  stateHistoryPruneBindings,
} from "../lib/state-history.ts";

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
    "app/api/state/history/route.ts",
    "lib/state-history.ts",
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
  assert.match(stateRoute, /MAX_STATE_BYTES = 1_500_000/);
  assert.match(stateRoute, /stateEtag\(revision: number, user: SessionUser\)/);
  assert.match(stateRoute, /status: 507/);
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

test("clean-checkout CI typechecks assets and compiles the Android application", async () => {
  const [workflow, assetTypes, eslintConfig] = await Promise.all([
    text(".github/workflows/ci.yml"),
    text("types/assets.d.ts"),
    text("eslint.config.mjs"),
  ]);
  assert.match(assetTypes, /declare module "\*\.css"/);
  assert.match(workflow, /android:\s*[\s\S]*\.\/gradlew testDebugUnitTest/);
  assert.match(workflow, /permissions:\s*[\s\S]*contents: read/);
  assert.match(workflow, /concurrency:\s*[\s\S]*cancel-in-progress: true/);
  assert.match(workflow, /npm ci[\s\S]*playwright-core install --with-deps chromium[\s\S]*npm run db:check[\s\S]*npm test/);
  assert.doesNotMatch(eslintConfig, /"build\/\*\*"/);
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
  assert.match(stateRoute, /warehouseHistoryMutationIssue\(previous, state, auth\.user\.role\)/);
  assert.match(stateRoute, /projectWarehouseStateForUser\(parsedState, auth\.user\)/);
  assert.match(stateRoute, /partial: auth\.user\.role === "worker"/);
  assert.match(stateRoute, /if \(body\.partial === true\)/);
  assert.match(stateRoute, /readJsonObject\(request, MAX_STATE_REQUEST_BYTES\)/);
  assert.match(stateRoute, /terminal: true, recover: "server"/);
  assert.match(stateRoute, /SELECT item_id AS itemId FROM warehouse_state_items/);
  assert.match(productsRoute, /requireUser\(request, \["owner", "admin"\]\)/);
  assert.match(stateRoute, /"state_updated"/);
  assert.doesNotMatch(stateRoute, /revision % 25/);
  assert.match(recoveryRoute, /clientThrottleKey\(request, "recovery-owner"\)/);
  assert.doesNotMatch(recoveryRoute, /clientThrottleKey\(request, "recovery", login\)/);
  assert.match(auth, /failures = login_throttle\.failures \+ 1/);
  assert.match(auth, /DELETE FROM login_throttle WHERE login = \? AND last_attempt_at = \?/);
  assert.match(auth, /fetchSite !== "same-origin" && fetchSite !== "none"/);
  assert.match(auth, /MAX_REJECTED_BODY_DRAIN_BYTES = 1_500_000 \+ 64 \* 1024/);
  assert.match(auth, /RETURNING failures, blocked_until/);
  assert.match(await text("app/api/auth/login/route.ts"), /DUMMY_PASSWORD_HASH/);
  assert.doesNotMatch(`${auth}\n${stateRoute}\n${productsRoute}`, /CREATE TABLE IF NOT EXISTS/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `warehouse_full_state`/);
});

test("sync hardening keeps conflicts recoverable and Android secrets protected", async () => {
  const [
    browserSync,
    androidStore,
    androidSync,
    activity,
    manifest,
    extractionRules,
    application,
    messagingService,
    serverContract,
    prototype,
  ] = await Promise.all([
    text("public/prototype-server.js"),
    text("android/app/src/main/java/com/treshka/sklad/AppStateStore.kt"),
    text("android/app/src/main/java/com/treshka/sklad/ServerSyncManager.kt"),
    text("android/app/src/main/java/com/treshka/sklad/MainActivity.kt"),
    text("android/app/src/main/AndroidManifest.xml"),
    text("android/app/src/main/res/xml/data_extraction_rules.xml"),
    text("android/app/src/main/java/com/treshka/sklad/WarehouseApplication.kt"),
    text("android/app/src/main/java/com/treshka/sklad/WarehouseFirebaseMessagingService.kt"),
    text("android/SERVER_API_CONTRACT.md"),
    text("public/prototype.html"),
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
  assert.match(androidStore, /DB_VERSION = 8/);
  assert.match(androidStore, /base_revision INTEGER NOT NULL DEFAULT 0/);
  assert.match(androidStore, /conflict INTEGER NOT NULL DEFAULT 0/);
  assert.match(androidStore, /fun claimNextPending\(\)/);
  assert.match(androidStore, /arrayOf\("mutation_id", "payload", "schema_version", "attempts", "base_revision"\)/);
  assert.match(androidStore, /UPDATE sync_outbox SET attempts=\? WHERE mutation_id=\? AND conflict=0/);
  assert.doesNotMatch(androidStore, /SET attempts=\?, base_revision=\?/);
  assert.match(androidStore, /LegacyOutboxMigration\.ALL_PENDING_ROWS/);
  assert.match(androidStore, /resetBaseRevision/);
  assert.match(androidStore, /", base_revision=0"/);
  assert.doesNotMatch(androidStore, /SET base_revision = COALESCE/);
  assert.match(androidStore, /db\.delete\("sync_outbox", "attempts = 0 AND conflict = 0"/);
  assert.doesNotMatch(androidStore, /fun markMutationAttempted\(/);
  assert.match(androidSync, /store\.markMutationConflicted\(pending\.mutationId, message\)/);
  assert.match(androidSync, /store\.sendablePendingCount\(\) == 0/);
  assert.match(androidSync, /store\.markSyncContact\(/);
  assert.match(androidSync, /refreshServerRole\(config, force = pending\.attempts <= 1\)/);
  assert.match(androidSync, /val pending = store\.pendingCounts\(\)/);
  assert.match(androidSync, /store\.savePendingRemoteSnapshot\(payload, revision\)/);
  assert.match(androidSync, /store\.acceptServerSnapshot\(id, allowDiscardWithoutBackup\)/);
  assert.doesNotMatch(androidSync, /localExportConfirmed/);
  assert.match(androidStore, /noBackupFilesDir/);
  assert.match(androidStore, /fun latestConflictBackupFile\(\)/);
  assert.doesNotMatch(androidStore, /file\.readBytes\(\)/);
  assert.match(androidStore, /SELECT rowid, mutation_id, payload, schema_version, created_at/);
  assert.match(activity, /requestNativeConflictDiscardConfirmation/);
  assert.match(activity, /fun exportLatestConflictBackup\(\)/);
  assert.match(activity, /source\.inputStream\(\)\.use/);
  assert.match(activity, /syncRoleCanAdminister/);
  assert.match(activity, /\(application as WarehouseApplication\)\.appStateStore/);
  assert.match(activity, /\(application as WarehouseApplication\)\.serverSyncManager/);
  assert.doesNotMatch(activity, /ServerSyncManager\(\s*appStateStore/);
  assert.match(activity, /conflictDiscardConfirmationVisible/);
  assert.match(application, /val appStateStore: AppStateStore by lazy/);
  assert.match(application, /val serverSyncManager: ServerSyncManager by lazy/);
  assert.match(messagingService, /\(application as WarehouseApplication\)\.serverSyncManager\.syncNow\(\)/);
  assert.doesNotMatch(messagingService, /ServerSyncManager\(/);
  assert.match(manifest, /android:name="\.WarehouseApplication"/);
  assert.match(androidSync, /\/v1\/auth\/status/);
  assert.match(androidSync, /Сервер входа не вернул обязательное поле user\.role/);
  assert.match(androidSync, /store\.updateServerRole\(role\)/);
  assert.match(androidSync, /SyncPolicy\.normalizeServerRole\(rawRole\)/);
  assert.match(androidSync, /!SyncPolicy\.isKnownServerRole\(rawRole\)/);
  assert.match(androidSync, /native privileges reduced to worker/);
  assert.equal(
    (androidStore.match(/server_revision=MAX\(server_revision, \?\)/g) ?? []).length,
    4,
    "every one of the four revision writes must remain monotonic",
  );
  assert.doesNotMatch(androidStore, /SET server_revision=\?/);
  assert.doesNotMatch(androidStore, /SET server_role=\?, last_error=NULL/);
  assert.match(browserSync, /if \(roleChanged && typeof window\.onTreshkaServerRoleChanged/);
  assert.equal(
    (browserSync.match(/^\s*installServerPrivilegeGuards\(\);\s*$/gm) ?? []).length,
    2,
    "privilege guards must run both at script start and after account controls are installed",
  );
  assert.match(serverContract, /not implemented in this repository/);
  assert.match(androidSync, /store\.clearServerRole\(message\)/);
  assert.match(androidStore, /"serverRoleUnknown"/);
  assert.match(prototype, /Не удалось подтвердить роль этого аккаунта/);
  assert.match(prototype, /conflictLoadError/);
  assert.match(prototype, /nativeRoleCanAdminister/);
  assert.match(prototype, /treshka_sklad_document_node_v1/);
  assert.match(prototype, /(?:ДФ\|АВР\|ВН)/);
  assert.match(browserSync, /state\.auditLog = Array\.isArray\(state\.auditLog\).*slice\(0, 2_000\)/);
  assert.match(browserSync, /!sync\.partial/);
  assert.match(browserSync, /authorizationChanged/);
  assert.match(browserSync, /mediaMigrationPromise/);
  assert.match(prototype, /window\.onTreshkaServerRoleChanged/);
  assert.match(browserSync, /window\.onTreshkaServerRoleChanged\(sync\.user\.role\)/);
  assert.match(serverContract, /`user\.role` is mandatory/);
  assert.match(androidSync, /store\.requeueConflictedMutation\(id, authoritative\.second\)/);
  assert.match(androidSync, /ConflictRequeueResult\.SERVER_ADVANCED/);
  assert.match(androidSync, /pending\.baseRevision/);
  assert.match(androidSync, /markMutationApplied\(pending\.mutationId, pending\.baseRevision, revision\)/);
  assert.match(androidSync, /rerunRequested\.set\(true\)/);
  assert.match(androidSync, /if \(rerunRequested\.getAndSet\(false\)\) syncNow\(\)/);
  assert.match(androidSync, /store\.pendingRemoteSnapshot\(\)\?\.let \{ return it \}/);
  assert.match(androidSync, /user\.isNull\("role"\)/);
  assert.doesNotMatch(androidSync, /store\.updateServerRevision/);
  assert.match(androidStore, /remoteRevision > baseRevision/);
  assert.match(androidStore, /db\.delete\("sync_remote_pending", "id=1"/);
  assert.match(androidSync, /val terminal = runCatching/);
  assert.match(androidSync, /val retryable = !terminal && SyncPolicy\.isRetryableHttp\(response\.code\)/);
  assert.match(androidSync, /store\.markMutationConflicted\(pending\.mutationId, message\)/);
  assert.doesNotMatch(androidSync, /scheduleRetry\(pending\.attempts, pending\.mutationId\)/);
  assert.doesNotMatch(androidStore, /releaseConflictedMutations/);
  assert.match(browserSync, /adoptServerUser\(data\.user\)/);
  assert.match(browserSync, /lastServerStateJson/);
  assert.doesNotMatch(browserSync, /lastServerState:\s*null/);
  assert.match(browserSync, /sync\.lastServerStateJson = payload/);
  assert.match(browserSync, /sync\.nextAttemptAt = Math\.max\(sync\.nextAttemptAt, Date\.now\(\) \+ 30_000\)/);
  assert.equal(
    (browserSync.match(/window\.treshkaServerRole\s*=/g) ?? []).length,
    1,
    "the server role provider must have one authoritative definition",
  );
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
  await text("dist/.openai/drizzle/0006_special_peter_quill.sql");
  await text("dist/.openai/drizzle/0007_cold_khan.sql");
  await text("dist/.openai/drizzle/0008_assignment_key_invariant.sql");
  await text("dist/.openai/drizzle/0009_living_leo.sql");
  await text("dist/.openai/drizzle/0010_optimal_ender_wiggin.sql");
  await text("dist/.openai/drizzle/0011_dear_war_machine.sql");
});

test("database migrations build a clean schema and adopt the legacy runtime state table", async () => {
  const migrations = await Promise.all([
    text("drizzle/0000_unique_vampiro.sql"),
    text("drizzle/0001_famous_the_hunter.sql"),
    text("drizzle/0002_quick_bloodscream.sql"),
    text("drizzle/0003_warehouse_full_state.sql"),
    text("drizzle/0004_pale_thanos.sql"),
    text("drizzle/0005_hard_moira_mactaggert.sql"),
    text("drizzle/0006_special_peter_quill.sql"),
    text("drizzle/0007_cold_khan.sql"),
    text("drizzle/0008_assignment_key_invariant.sql"),
    text("drizzle/0009_living_leo.sql"),
    text("drizzle/0010_optimal_ender_wiggin.sql"),
    text("drizzle/0011_dear_war_machine.sql"),
    text("drizzle/0012_young_proemial_gods.sql"),
    text("drizzle/0013_thin_radioactive_man.sql"),
  ]);
  const apply = (database, sql) => {
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) database.exec(statement);
    }
  };
  assert.match(migrations[5], /ALTER TABLE `push_deliveries` ADD `attempts`/);
  assert.doesNotMatch(migrations[6], /ALTER TABLE/);
  assert.match(migrations[7], /ALTER TABLE `users` ADD `assignment_key`/);
  assert.match(migrations[8], /CREATE TRIGGER `users_assignment_key_after_insert`/);
  assert.match(migrations[9], /CREATE TABLE `warehouse_state_revisions`/);
  assert.match(migrations[9], /INSERT OR IGNORE INTO `warehouse_state_revisions`/);
  assert.match(migrations[10], /ADD `size_bytes`/);
  assert.match(migrations[10], /ADD `archived_at`/);
  assert.match(migrations[10], /SET `size_bytes` = length\(`payload`\)/);
  assert.match(migrations[11], /CREATE TABLE `inventory_act_archive`/);
  assert.match(migrations[11], /CREATE TABLE `inventory_act_counters`/);
  assert.match(migrations[12], /CREATE TABLE `warehouse_state_inventory_acts`/);
  assert.match(migrations[12], /ADD `pinned`/);
  assert.match(migrations[12], /ADD `reason`/);
  assert.match(migrations[12], /json_each\(warehouse_full_state\.payload, '\$\.inventoryActs'\)/);
  assert.match(migrations[13], /DROP TABLE `inventory_act_counters`/);
  assert.match(migrations[13], /ADD `header_json`/);
  assert.match(migrations[13], /SET `header_json` = COALESCE/);

  const clean = new DatabaseSync(":memory:");
  for (const migration of migrations) apply(clean, migration);
  apply(clean, migrations[6]);
  assert.deepEqual(
    clean.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map((row) => row.name),
    ["audit_log", "inventory_act_archive", "login_throttle", "products", "push_deliveries", "push_delivery_attempts", "push_devices", "push_events", "push_maintenance_state", "sessions", "users", "warehouse_full_state", "warehouse_state_inventory_acts", "warehouse_state_items", "warehouse_state_revisions"],
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
  apply(adopted, migrations[6]);
  adopted.prepare(
    `INSERT INTO users
       (id, callsign, login, password_hash, role, assignment, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).run("legacy-worker", "Тест", "legacy-worker", "hash", "worker", "  тЭч  ", "2026-07-26");
  apply(adopted, migrations[7]);
  apply(adopted, migrations[8]);
  apply(adopted, migrations[9]);
  apply(adopted, migrations[10]);
  apply(adopted, migrations[11]);
  apply(adopted, migrations[12]);
  apply(adopted, migrations[13]);
  assert.deepEqual(
    adopted.prepare("SELECT item_id AS itemId FROM warehouse_state_items WHERE state_key='main'").all()
      .map((row) => row.itemId),
    ["legacy-item"],
  );
  assert.equal(adopted.prepare("SELECT COUNT(*) AS count FROM push_delivery_attempts").get().count, 0);
  assert.equal(
    adopted.prepare("SELECT revision FROM warehouse_state_revisions WHERE state_key='main'").get().revision,
    4,
  );
  assert.ok(
    adopted.prepare("SELECT size_bytes AS sizeBytes FROM warehouse_state_revisions WHERE state_key='main'").get().sizeBytes > 0,
  );
  assert.equal(
    adopted.prepare("SELECT archived_at AS archivedAt FROM warehouse_state_revisions WHERE state_key='main'").get().archivedAt,
    "2026-07-25",
  );
  assert.equal(
    adopted.prepare("SELECT assignment_key AS key FROM users WHERE id='legacy-worker'").get().key,
    "тэч",
  );
  adopted.prepare(
    `INSERT INTO users
       (id, callsign, login, password_hash, role, assignment, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).run(
    "whitespace-worker",
    "Пробел",
    "whitespace-worker",
    "hash",
    "worker",
    `\tТЭЧ\u00a0${" ".repeat(40)}1\r\n`,
    "2026-07-26",
  );
  assert.equal(
    adopted.prepare("SELECT assignment_key AS key FROM users WHERE id='whitespace-worker'").get().key,
    "тэч 1",
  );
  adopted.prepare(
    `INSERT INTO users
       (id, callsign, login, password_hash, role, assignment, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).run(
    "unicode-worker",
    "Юникод",
    "unicode-worker",
    "hash",
    "worker",
    "\u202fÉЛЕКТРО\u202f",
    "2026-07-26",
  );
  assert.equal(
    adopted.prepare("SELECT assignment_key AS key FROM users WHERE id='unicode-worker'").get().key,
    "\u202fÉлектро\u202f",
  );
  adopted.close();
});

test("state revision history is sampled, time-retained and shared by every writer", async () => {
  const [policy, stateRoute, productRoute, historyRoute] = await Promise.all([
    text("lib/state-history.ts"),
    text("app/api/state/route.ts"),
    text("app/api/products/route.ts"),
    text("app/api/state/history/route.ts"),
  ]);
  assert.match(policy, /STATE_HISTORY_RETENTION_DAYS = 30/);
  assert.match(policy, /STATE_HISTORY_SAMPLE_INTERVAL_MS = 5 \* 60 \* 1_000/);
  assert.match(policy, /STATE_HISTORY_FULL_DETAIL_HOURS = 24/);
  assert.match(policy, /STATE_HISTORY_HOURLY_DAYS = 7/);
  assert.match(policy, /STATE_HISTORY_LIST_LIMIT = 500/);
  assert.match(policy, /STATE_HISTORY_MAX_ROWS = 500/);
  assert.match(stateRoute, /stateHistorySampleCutoff\(\)/);
  assert.match(stateRoute, /stateHistoryArchiveTimestamp\(\)/);
  assert.match(stateRoute, /STATE_HISTORY_PRUNE_SQL/);
  assert.match(stateRoute, /stateHistoryPruneBindings\(\)/);
  assert.match(stateRoute, /archived_at = \? AND revision = \?/);
  assert.match(productRoute, /STATE_HISTORY_PRUNE_SQL/);
  assert.match(productRoute, /STATE_HISTORY_MAX_ROWS/);
  assert.match(historyRoute, /STATE_HISTORY_LIST_LIMIT/);
  assert.match(historyRoute, /oldestArchivedAt/);
  assert.match(historyRoute, /size_bytes AS sizeBytes/);
  assert.match(historyRoute, /archived_at AS archivedAt/);
  assert.match(historyRoute, /status: 507/);
  assert.match(historyRoute, /item_id NOT IN \(SELECT id FROM products\)/);
});

test("state revision thinning keeps detailed, hourly and daily recovery points", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE warehouse_state_revisions (
      state_key TEXT NOT NULL,
      revision INTEGER NOT NULL,
      archived_at TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT 'sample'
    )
  `);
  const insert = database.prepare(
    "INSERT INTO warehouse_state_revisions (state_key, revision, archived_at) VALUES ('main', ?, ?)",
  );
  const now = Date.parse("2026-07-27T12:00:00.000Z");
  let revision = 1;
  for (
    let timestamp = now - 31 * 24 * 60 * 60 * 1_000;
    timestamp <= now;
    timestamp += 5 * 60 * 1_000
  ) {
    insert.run(revision, new Date(timestamp).toISOString());
    revision += 1;
  }

  database.prepare(STATE_HISTORY_PRUNE_SQL).run(...stateHistoryPruneBindings(now));
  database.prepare(STATE_HISTORY_CAP_SQL).run(STATE_HISTORY_MAX_ROWS);

  const count = Number(database.prepare(
    "SELECT COUNT(*) AS count FROM warehouse_state_revisions WHERE state_key = 'main'",
  ).get().count);
  assert.ok(count >= 440 && count <= 500, `unexpected retained revision count: ${count}`);
  assert.equal(Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM warehouse_state_revisions
    WHERE archived_at < ?
  `).get(new Date(now - 30 * 24 * 60 * 60 * 1_000).toISOString()).count), 0);
  assert.equal(Number(database.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT substr(archived_at, 1, 13) AS bucket, COUNT(*) AS amount
      FROM warehouse_state_revisions
      WHERE archived_at >= ? AND archived_at < ?
      GROUP BY bucket HAVING amount > 1
    )
  `).get(
    new Date(now - 7 * 24 * 60 * 60 * 1_000).toISOString(),
    new Date(now - 24 * 60 * 60 * 1_000).toISOString(),
  ).count), 0);
  assert.equal(Number(database.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT substr(archived_at, 1, 10) AS bucket, COUNT(*) AS amount
      FROM warehouse_state_revisions
      WHERE archived_at >= ? AND archived_at < ?
      GROUP BY bucket HAVING amount > 1
    )
  `).get(
    new Date(now - 30 * 24 * 60 * 60 * 1_000).toISOString(),
    new Date(now - 7 * 24 * 60 * 60 * 1_000).toISOString(),
  ).count), 0);
  database.close();
});

test("destructive recovery points survive thinning and the ordinary row cap", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE warehouse_state_revisions (
      state_key TEXT NOT NULL,
      revision INTEGER NOT NULL,
      archived_at TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT 'sample'
    )
  `);
  const insert = database.prepare(
    "INSERT INTO warehouse_state_revisions (state_key, revision, archived_at, pinned, reason) VALUES ('main', ?, ?, ?, ?)",
  );
  const now = Date.parse("2026-07-27T12:00:00.000Z");
  const bucket = new Date(now - 3 * 24 * 60 * 60 * 1_000).toISOString();
  insert.run(100, bucket, 0, "sample");
  insert.run(101, new Date(Date.parse(bucket) + 60_000).toISOString(), 1, "product_delete");
  insert.run(102, new Date(Date.parse(bucket) + 120_000).toISOString(), 0, "sample");
  for (let revision = 200; revision < 800; revision += 1) {
    insert.run(revision, new Date(now - (800 - revision) * 1_000).toISOString(), 0, "sample");
  }
  database.prepare(STATE_HISTORY_PRUNE_SQL).run(...stateHistoryPruneBindings(now));
  database.prepare(STATE_HISTORY_CAP_SQL).run(STATE_HISTORY_MAX_ROWS);
  const pinned = database.prepare(
    "SELECT pinned, reason FROM warehouse_state_revisions WHERE revision = 101",
  ).get();
  assert.equal(pinned.pinned, 1);
  assert.equal(pinned.reason, "product_delete");
  database.close();
});

test("inventory archive stays within D1 row limits and allocates numbers atomically", async () => {
  const [inventoryRoute, stateRoute, browserSync] = await Promise.all([
    text("app/api/inventory/acts/route.ts"),
    text("app/api/state/route.ts"),
    text("public/prototype-server.js"),
  ]);
  assert.match(inventoryRoute, /MAX_ACT_BYTES = 1_800_000/);
  assert.match(inventoryRoute, /MAX_ACT_LINES = 15_000/);
  assert.match(inventoryRoute, /new TextEncoder\(\)\.encode\(payload\)\.byteLength > MAX_ACT_BYTES/);
  assert.match(inventoryRoute, /json_set\(\?, '\$\.no', candidate\.number\)/);
  assert.match(inventoryRoute, /RETURNING id, number, payload, actor_user_id/);
  assert.doesNotMatch(inventoryRoute, /INSERT INTO inventory_act_counters/);
  assert.match(inventoryRoute, /LEFT JOIN warehouse_state_inventory_acts AS state_act/);
  assert.match(inventoryRoute, /archive\.actor_user_id = \?/);
  assert.match(stateRoute, /warehouse_state_inventory_acts/);
  assert.match(stateRoute, /header_json AS headerJson/);
  assert.match(stateRoute, /nextInventoryActHeaders\.get\(actId\) !== headerJson/);
  assert.match(stateRoute, /previousItemIds\.length === 0 && Number\(productCount\?\.count/);
  assert.match(stateRoute, /state_history_mutation_rejected/);
  assert.match(browserSync, /data\.terminal === true/);
  assert.match(browserSync, /recoverPendingInventoryActs/);
});

test("Android WebView exposes JavaScript alert and confirm dialogs for destructive actions", async () => {
  const [activity, prototype] = await Promise.all([
    text("android/app/src/main/java/com/treshka/sklad/MainActivity.kt"),
    text("public/prototype.html"),
  ]);
  assert.match(activity, /override fun onJsAlert/);
  assert.match(activity, /override fun onJsConfirm/);
  assert.ok((activity.match(/override fun onJsConfirm/g) ?? []).length >= 2);
  assert.match(activity, /result\.confirm\(\)/);
  assert.match(activity, /result\.cancel\(\)/);
  assert.match(prototype, /id="restoreRevisionCode"/);
  assert.match(prototype, /id="restoreRevisionButton" disabled/);
});

test("push notifications are server-addressed, durable and connected to Android FCM", async () => {
  const [eventsRoute, pushEvents, devicesRoute, maintenance, fcm, bridge, prototype, service, activity, migration, metadataMigration, routingMigration, invariantMigration] = await Promise.all([
    text("app/api/notifications/events/route.ts"),
    text("lib/push-events.ts"),
    text("app/api/devices/register/route.ts"),
    text("lib/push-maintenance.ts"),
    text("lib/fcm.ts"),
    text("public/prototype-server.js"),
    text("public/prototype.html"),
    text("android/app/src/main/java/com/treshka/sklad/WarehouseFirebaseMessagingService.kt"),
    text("android/app/src/main/java/com/treshka/sklad/MainActivity.kt"),
    text("drizzle/0004_pale_thanos.sql"),
    text("drizzle/0006_special_peter_quill.sql"),
    text("drizzle/0007_cold_khan.sql"),
    text("drizzle/0008_assignment_key_invariant.sql"),
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
  assert.match(eventsRoute, /result\.status === "disabled"/);
  assert.match(eventsRoute, /rows\.length\s*&& responseBody\.failed > 0/);
  assert.match(eventsRoute, /push_delivery_attempts/);
  assert.match(eventsRoute, /collectPushRecipients/);
  assert.match(eventsRoute, /maybeRunPushMaintenance/);
  assert.match(eventsRoute, /push_events\.created_at >= \?/);
  assert.match(eventsRoute, /catch \(error\) \{\s*\/\/ Retention is best-effort housekeeping/);
  assert.match(maintenance, /DELETE FROM push_deliveries WHERE NOT EXISTS/);
  assert.match(maintenance, /UPDATE push_maintenance_state SET last_run_at/);
  assert.match(maintenance, /releasePushMaintenanceClaim/);
  assert.match(pushEvents, /PUSH_RECIPIENT_MAX_PAGES/);
  assert.match(eventsRoute, /Promise\.all\(batch\.map/);
  assert.match(eventsRoute, /offset \+= 8/);
  assert.match(fcm, /firebase\.messaging/);
  assert.match(fcm, /fcm\.googleapis\.com\/v1\/projects/);
  assert.match(fcm, /pendingAccessToken/);
  assert.match(fcm, /!forceRefresh \|\| pendingAccessToken\.forced/);
  assert.match(fcm, /response\.status === 401/);
  assert.match(fcm, /response\.status === 429 \|\| response\.status >= 500/);
  assert.match(bridge, /PUSH_QUEUE_KEY/);
  assert.match(bridge, /MAX_PUSH_QUEUE = 500/);
  assert.match(bridge, /PUSH_EVENT_TTL_MS/);
  assert.match(bridge, /response\.json\(\)\.catch\(\(\) => \(\{\}\)\)/);
  assert.match(bridge, /Очередь уведомлений заполнена/);
  assert.match(bridge, /nextAttemptAt/);
  assert.match(bridge, /push\.queue\.splice\(eventIndex, 1\);\s*push\.queue\.push\(event\)/);
  assert.doesNotMatch(bridge, /parsed\.filter\(\(entry\) => entry && entry\.actorUserId === sync\.user/);
  assert.match(bridge, /registerNativePush/);
  assert.match(service, /POST_NOTIFICATIONS/);
  assert.match(activity, /AndroidPush/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `push_devices`/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `push_events`/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `push_deliveries`/);
  assert.match(metadataMigration, /CREATE TABLE IF NOT EXISTS `push_delivery_attempts`/);
  assert.match(metadataMigration, /CREATE TABLE IF NOT EXISTS `warehouse_state_items`/);
  assert.match(routingMigration, /ALTER TABLE `users` ADD `assignment_key`/);
  assert.match(routingMigration, /CREATE TABLE `push_maintenance_state`/);
  assert.match(invariantMigration, /AFTER UPDATE OF `assignment` ON `users`/);
});
