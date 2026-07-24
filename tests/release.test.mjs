import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
