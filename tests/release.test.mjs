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

test("secrets are runtime environment variables, never embedded values", async () => {
  const [setup, recovery] = await Promise.all([
    text("app/api/auth/setup/route.ts"),
    text("app/api/auth/recover-owner/route.ts"),
  ]);
  assert.match(setup, /INITIAL_SETUP_CODE/);
  assert.match(recovery, /OWNER_RECOVERY_CODE/);
  assert.doesNotMatch(`${setup}\n${recovery}`, /github_pat_/);
});
