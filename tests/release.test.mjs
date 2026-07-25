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
  assert.match(gradle, /versionCode 7/);
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
  assert.match(stateRoute, /"state_updated"/);
  assert.doesNotMatch(stateRoute, /revision % 25/);
  assert.match(recoveryRoute, /clientThrottleKey\(request, "recovery-owner"\)/);
  assert.doesNotMatch(recoveryRoute, /clientThrottleKey\(request, "recovery", login\)/);
  assert.match(auth, /failures = login_throttle\.failures \+ 1/);
  assert.match(auth, /DELETE FROM login_throttle WHERE login = \? AND last_attempt_at = \?/);
  assert.match(auth, /fetchSite !== "same-origin" && fetchSite !== "none"/);
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
  assert.match(androidStore, /SyncTokenVault/);
  assert.match(androidStore, /AndroidKeyStore/);
  assert.match(androidStore, /db\.delete\("sync_outbox", "attempts = 0"/);
  assert.match(androidSync, /scheduleRetry\(pending\.attempts \+ 1\)/);
  assert.match(activity, /uri\.host != APP_HOST/);
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(manifest, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
  assert.match(extractionRules, /<exclude domain="root" path="\." \/>/);
});

test("database migrations build a clean schema and adopt the legacy runtime state table", async () => {
  const migrations = await Promise.all([
    text("drizzle/0000_unique_vampiro.sql"),
    text("drizzle/0001_famous_the_hunter.sql"),
    text("drizzle/0002_quick_bloodscream.sql"),
    text("drizzle/0003_warehouse_full_state.sql"),
  ]);
  const apply = (database, sql) => {
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) database.exec(statement);
    }
  };

  const clean = new DatabaseSync(":memory:");
  for (const migration of migrations) apply(clean, migration);
  assert.deepEqual(
    clean.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map((row) => row.name),
    ["audit_log", "login_throttle", "products", "sessions", "users", "warehouse_full_state"],
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
    )
  `);
  apply(adopted, migrations[3]);
  assert.equal(
    adopted.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('warehouse_full_state')").get().count,
    5,
  );
  adopted.close();
});
