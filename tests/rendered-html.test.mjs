import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const text = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("built release contains the real warehouse shell rather than the starter preview", async () => {
  const [page, layout, prototype, serverBridge] = await Promise.all([
    text("app/page.tsx"),
    text("app/layout.tsx"),
    text("public/prototype.html"),
    text("public/prototype-server.js"),
  ]);

  assert.match(page, /Проверяем доступ/);
  assert.match(page, /prototype\.html\?server=1/);
  assert.match(layout, /ТРЁШКА СКЛАД/);
  assert.match(prototype, /Акт дефектовки/);
  assert.match(prototype, /Акт выполненных работ/);
  assert.match(serverBridge, /treshka-sync-conflict/);
  assert.doesNotMatch(`${page}\n${layout}`, /Your site is taking shape|Building your site|Starter Project/);
});

test("production shell exposes conflict resolution and guards displayed photos", async () => {
  const [page, prototype, stateRoute] = await Promise.all([
    text("app/page.tsx"),
    text("public/prototype.html"),
    text("app/api/state/route.ts"),
  ]);
  assert.match(page, /Серверную/);
  assert.match(page, /resolveSyncConflict\("local"\)/);
  assert.match(prototype, /function safePhotoDataUrl/);
  assert.match(prototype, /safePhotoDataUrl\(dataUrl\)/);
  assert.match(prototype, /function safePhotoSource/);
  assert.match(stateRoute, /delete state\.accounts/);
  assert.match(stateRoute, /DELETE|delete state\.currentRole/);
});
