// Регрессионный набор для public/prototype.html («ТРЁШКА склад»).
//
// Почему так: прототип — это один файл HTML/JS без сборки и без модулей,
// поэтому классический unit-тест с импортом невозможен. Вместо этого тесты
// грузят файл в headless Chromium через Playwright и дёргают внутренние
// функции напрямую через page.evaluate() — это быстрее и точнее, чем
// кликать по DOM, а нам как раз важно проверять поведение функций
// (сохранение, миграции, роли, экспорт), а не вёрстку.
//
// Запуск: npm run test:sklad
// (добавляет playwright-core в devDependencies — см. package.json).
//
// Покрывает пункты код-ревью от 2026-07-22 (branch C_Sklad):
//  #1 — ошибка сохранения не должна считаться успехом
//  #2 — резервная копия реально используется при повреждении основной
//  #3 — экспорт в Excel сохраняется через нативный мост, а не Blob-фикцию
//  #4 — печать идёт через нативный мост, а не через window.print()
//  #5 — переключение на привилегированную роль требует ПИН
//  #6 — «Работник» не может выгрузить весь склад
//  #7 — миграция схемы не применяется частично/для неизвестной версии
//  #8 — системная кнопка "Назад" обрабатывает JS-стек навигации
// Плюс регрессия по более ранним раундам: неизменяемый id в QR, точный
// возврат по партии/сроку годности, разграничение документов по посту.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const PROTOTYPE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'prototype.html',
);
const PROTOTYPE_URL = 'file://' + PROTOTYPE_PATH;
const SERVER_SYNC_PATH = path.join(path.dirname(PROTOTYPE_PATH), 'prototype-server.js');
const PROTOTYPE_SOURCE = readFileSync(PROTOTYPE_PATH, 'utf8');
const SERVER_SYNC_SOURCE = readFileSync(SERVER_SYNC_PATH, 'utf8');

function serverStateFixture() {
  return {
    schemaVersion: 4,
    itemSeq: 1,
    categoriesList: ['Расходные материалы'],
    componentSubcats: [],
    accountSeq: 0,
    notificationSeq: 0,
    items: [{
      id: 'server-item',
      name: 'Серверный товар',
      sku: 'SERVER-001',
      topCat: 'Расходные материалы',
      unit: 'шт',
      stock: 5,
      min: 0,
      abc: 'A',
      ext: 0,
      posts: { 'ТЭЧ': 2 },
      history: [],
      lots: [],
    }],
    posts: [{ id: 'server-post', name: 'ТЭЧ', stock: [], repairs: [] }],
    docs: [],
    extIssues: [],
    stockTransfers: [],
    inventoryActs: [],
    auditLog: [],
    notifications: [],
  };
}

async function newHttpServerPage({
  role = 'worker',
  putStatus = 200,
  promoteToRole = null,
  embeddedPhoto = false,
  mediaDelayMs = 0,
  emptyState = false,
  historyRestoreStatus = 200,
} = {}) {
  const ctx = await browser.newContext();
  const state = serverStateFixture();
  if (embeddedPhoto) {
    state.items[0].photo = 'data:image/png;base64,aGVsbG8=';
    state.items[0].photoMedia = null;
  }
  let stateGets = 0;
  let statePuts = 0;
  let mediaPosts = 0;
  let historyGets = 0;
  let historyRestores = 0;
  const putBodies = [];
  await ctx.route('http://treshka.test/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/prototype.html') {
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PROTOTYPE_SOURCE });
      return;
    }
    if (url.pathname === '/prototype-server.js') {
      await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: SERVER_SYNC_SOURCE });
      return;
    }
    if (url.pathname === '/api/state' && request.method() === 'GET') {
      stateGets += 1;
      const forcedFullFetch = !request.headers()['if-none-match'];
      if (
        stateGets === 1
        || (stateGets === 2 && promoteToRole)
        || (stateGets > 2 && promoteToRole && forcedFullFetch)
        || (historyRestores > 0 && forcedFullFetch)
      ) {
        const responseRole = stateGets >= 2 && promoteToRole ? promoteToRole : role;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { etag: `W/"warehouse-main-7-test-${responseRole}"` },
          body: JSON.stringify({
            revision: historyRestores > 0 ? 8 : 7,
            state: emptyState ? null : state,
            partial: responseRole === 'worker',
            user: {
              id: 'test-promotable-user',
              callsign: `Тест ${responseRole}`,
              login: 'test-promotable-user',
              role: responseRole,
              assignment: responseRole === 'worker' ? 'ТЭЧ' : '',
            },
          }),
        });
      } else {
        await route.fulfill({
          status: 304,
          headers: { etag: 'W/"warehouse-main-7-test-scope"' },
          body: '',
        });
      }
      return;
    }
    if (url.pathname === '/api/state/history' && request.method() === 'GET') {
      historyGets += 1;
      const revision = Number(url.searchParams.get('revision') || 0);
      const metadata = {
        revision: revision || 6,
        updatedAt: '2026-07-26T08:00:00.000Z',
        updatedBy: 'Тестовый владелец',
        archivedAt: '2026-07-26T08:05:00.000Z',
        sizeBytes: JSON.stringify(state).length,
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(revision
          ? { ...metadata, state }
          : { revisions: [metadata], oldestArchivedAt: metadata.archivedAt }),
      });
      return;
    }
    if (url.pathname === '/api/state/history' && request.method() === 'POST') {
      historyRestores += 1;
      const status = role === 'owner' ? historyRestoreStatus : 403;
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: status === 200
          ? JSON.stringify({
            revision: 8,
            restoredFrom: Number(JSON.parse(request.postData() || '{}').revision),
            updatedAt: '2026-07-26T09:00:00.000Z',
            discardedItemReferences: 2,
          })
          : JSON.stringify({ error: 'Восстанавливать ревизии может только владелец' }),
      });
      return;
    }
    if (url.pathname === '/api/state' && request.method() === 'PUT') {
      statePuts += 1;
      putBodies.push(JSON.parse(request.postData() || '{}'));
      await route.fulfill({
        status: putStatus,
        contentType: 'application/json',
        body: putStatus === 413
          ? JSON.stringify({ error: 'Данные склада превышают безопасный размер 1,5 МБ' })
          : JSON.stringify({ revision: 8 }),
      });
      return;
    }
    if (url.pathname === '/api/media/images' && request.method() === 'POST') {
      mediaPosts += 1;
      if (mediaDelayMs) await new Promise((resolve) => setTimeout(resolve, mediaDelayMs));
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          key: `images/${String(mediaPosts).padStart(8, '0')}-0000-4000-8000-000000000000.png`,
          url: `/api/media/images?key=images%2F${String(mediaPosts).padStart(8, '0')}-0000-4000-8000-000000000000.png`,
        }),
      });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  const page = await ctx.newPage();
  await page.goto('http://treshka.test/prototype.html?server=1');
  await page.waitForFunction(() => window.treshkaServerSync?.status().ready === true);
  return {
    ctx,
    page,
    counts: () => ({ stateGets, statePuts, mediaPosts, historyGets, historyRestores }),
    putBodies,
  };
}

let browser;

before(async () => {
  // Пытаемся использовать системный Chrome (обычно уже стоит на машине
  // разработчика) — так не нужно тянуть отдельный браузер только ради тестов.
  // Если его нет, пробуем браузер, который playwright-core сам нашёл бы
  // по умолчанию (например, установленный ранее через `npx playwright install`).
  try {
    browser = await chromium.launch({ channel: 'chrome' });
  } catch {
    try {
      browser = await chromium.launch();
    } catch (e) {
      throw new Error(
        'Не удалось запустить Chromium для тестов. Установите Google Chrome, ' +
        'либо выполните `npx playwright install chromium` и повторите `npm run test:sklad`. ' +
        'Исходная ошибка: ' + (e && e.message),
      );
    }
  }
});

after(async () => {
  if (browser) await browser.close();
});

// Каждый тест — свежий контекст (свой localStorage/сессия), но общий browser
// process — так тесты изолированы друг от друга и при этом быстро стартуют.
// `initArg`, если передан, сериализуется и передаётся первым параметром в
// `initScript` уже внутри страницы (см. Playwright addInitScript(fn, arg)) —
// так тестовые моки могут замыкать над значениями, вычисленными в Node.
async function newPage(initScript, initArg) {
  const ctx = await browser.newContext();
  if (initScript) await ctx.addInitScript(initScript, initArg);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(PROTOTYPE_URL);
  await page.waitForTimeout(250);
  return { ctx, page, pageErrors };
}

test('loads without console/page errors and exposes all expected subsystems', async () => {
  const { ctx, page, pageErrors } = await newPage();
  const r = await page.evaluate(() => ({
    hasXLSX: typeof XLSX !== 'undefined',
    hasQrcode: typeof qrcode !== 'undefined',
    hasPersistence: typeof flushSave === 'function' && typeof loadAppStateOnStart === 'function',
    hasScan: typeof startNativeScan === 'function' && typeof onNativeScanResult === 'function',
    hasRoleGuard: typeof requestRoleSwitch === 'function'
      && typeof ROLE_PINS === 'object'
      && Object.keys(ROLE_PINS).length === 0,
    hasNativeBack: typeof __handleNativeBack === 'function',
    hasFileBridge: typeof nativeFileBridge === 'function',
    hasPrintBridge: typeof nativePrintBridge === 'function',
    itemsLoaded: items.length > 0,
  }));
  assert.equal(pageErrors.length, 0, 'no uncaught page errors: ' + pageErrors.join('; '));
  for (const [k, v] of Object.entries(r)) assert.equal(v, true, `expected ${k} to be true`);
  await ctx.close();
});

test('#1 — flushSave() treats a failed native save as failure and retries, not as success', async () => {
  const { ctx, page } = await newPage(() => {
    window.__shouldFail = true;
    window.__saveCalls = 0;
    window.AndroidStorage = {
      saveState: (json) => {
        window.__saveCalls++;
        if (window.__shouldFail) return false;
        window.__savedPayload = json;
        return true;
      },
      loadState: () => 'null',
    };
  });
  const afterStartup = await page.evaluate(() => ({ calls: window.__saveCalls, healthy: _saveIsHealthy }));
  assert.equal(afterStartup.healthy, false, 'a failed save must not be marked healthy');

  await page.evaluate(() => { items[0].name = 'FAIL-TEST'; });
  await page.waitForTimeout(2000); // periodic autosave should retry
  const stillFailing = await page.evaluate(() => ({ calls: window.__saveCalls, healthy: _saveIsHealthy }));
  assert.ok(stillFailing.calls > afterStartup.calls, 'must keep retrying while the bridge fails');
  assert.equal(stillFailing.healthy, false);

  await page.evaluate(() => { window.__shouldFail = false; });
  await page.waitForTimeout(2000);
  const recovered = await page.evaluate(() => ({
    healthy: _saveIsHealthy,
    savedHasName: (window.__savedPayload || '').includes('FAIL-TEST'),
  }));
  assert.equal(recovered.healthy, true, 'must recover once the bridge starts succeeding');
  await ctx.close();
});

test('#2 — corrupted primary falls back to a valid backup', async () => {
  const goodBackup = JSON.stringify({
    schemaVersion: 1,
    items: [{ id: 'x', name: 'FROM_BACKUP', sku: 'B-1', topCat: 'Расход', unit: 'шт', stock: 5, min: 1, abc: 'A', posts: {}, history: [], lots: [] }],
    posts: [], docs: [], extIssues: [], auditLog: [], itemSeq: 1000,
    categoriesList: ['Расход'], componentSubcats: [], currentRole: 'admin', currentUserPost: 'ТЭЧ',
  });
  const { ctx, page } = await newPage((backup) => {
    window.AndroidStorage = {
      saveState: () => true,
      loadState: () => '{ this is not valid json',
      loadBackupState: () => backup,
    };
  }, goodBackup);
  const r = await page.evaluate(() => ({
    itemName: items[0] ? items[0].name : null,
    suspended: _autosaveSuspended,
  }));
  assert.equal(r.itemName, 'FROM_BACKUP', 'must restore from the backup slot when primary is corrupt');
  assert.equal(r.suspended, false, 'autosave should resume normally once backup restore succeeds');
  await ctx.close();
});

test('#2 — both primary and backup corrupted: demo data used, autosave suspended (no silent overwrite)', async () => {
  const { ctx, page } = await newPage(() => {
    window.__saveCalls = 0;
    window.AndroidStorage = {
      saveState: () => { window.__saveCalls++; return true; },
      loadState: () => '{ not valid',
      loadBackupState: () => '{ also not valid',
    };
  });
  await page.waitForTimeout(2200); // give the periodic autosave a chance to fire if it (incorrectly) wasn't suspended
  const r = await page.evaluate(() => ({
    itemsLen: items.length,
    suspended: _autosaveSuspended,
    saveCalls: window.__saveCalls,
  }));
  assert.ok(r.itemsLen > 0, 'demo data still usable');
  assert.equal(r.suspended, true, 'autosave must be suspended so the corrupted raw data stays recoverable');
  assert.equal(r.saveCalls, 0, 'must not write demo data over the only remaining (corrupted) copies');
  await ctx.close();
});

test('#7 — schema migration refuses newer-than-known or unmigratable-older data instead of partial-applying', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => {
    const base = JSON.parse(JSON.stringify(serializeAppState()));
    const okNewer = applyAppState({ ...base, schemaVersion: APP_SCHEMA_VERSION + 1 });
    // Версия, для которой заведомо НЕТ зарегистрированной миграции (ниже самой
    // старой ступени STATE_MIGRATIONS) — должна быть отвергнута целиком.
    const okNoMigrationPath = APP_SCHEMA_VERSION > 1
      ? applyAppState({ ...base, schemaVersion: 0 })
      : null;
    // Версия на одну ступень старше текущей ДОЛЖНА успешно мигрировать, если
    // для неё зарегистрирован шаг в STATE_MIGRATIONS (сейчас это v1 → v2) —
    // это не "неизвестная" версия, а ровно тот путь обновления, который
    // STATE_MIGRATIONS/migrateAppState обязаны поддерживать.
    const okOlderWithMigration = APP_SCHEMA_VERSION > 0
      ? applyAppState({ ...base, schemaVersion: APP_SCHEMA_VERSION - 1 })
      : null;
    const okExact = applyAppState({ ...base });
    return { okNewer, okNoMigrationPath, okOlderWithMigration, okExact };
  });
  assert.equal(r.okNewer, false, 'must refuse data from a schema version newer than this app understands');
  if (r.okNoMigrationPath !== null) {
    assert.equal(r.okNoMigrationPath, false, 'must refuse older data with no registered migration path');
  }
  if (r.okOlderWithMigration !== null) {
    assert.equal(r.okOlderWithMigration, true, 'must successfully migrate older data when a migration step is registered for it');
  }
  assert.equal(r.okExact, true, 'exact schema version match must still apply normally');
  await ctx.close();
});

test('business record ids are immutable and document numbers remain monotonic after deletion', async () => {
  const { ctx, page } = await newPage();
  const result = await page.evaluate(() => {
    const firstDefect = nextDocumentNo('defekt');
    docs.push({ id: newBusinessRecordId('defect-act'), no: firstDefect, kind: 'defekt' });
    docs.pop();
    const secondDefect = nextDocumentNo('defekt');

    const firstExternal = nextExternalIssueNo();
    extIssues.push({ id: newBusinessRecordId('external-issue'), no: firstExternal });
    extIssues.pop();
    const secondExternal = nextExternalIssueNo();

    const ids = [newBusinessRecordId('work-act'), newBusinessRecordId('work-act')];
    const saved = serializeAppState();
    return {
      firstDefect,
      secondDefect,
      firstExternal,
      secondExternal,
      uniqueIds: ids[0] !== ids[1] && ids.every((id) => id.startsWith('work-act-')),
      persistedDefectSeq: saved.documentSeq.defekt,
      persistedExternalSeq: saved.externalIssueSeq,
    };
  });
  const { ctx: otherCtx, page: otherPage } = await newPage();
  const otherDeviceDefect = await otherPage.evaluate(() => nextDocumentNo('defekt'));
  const sequence = (value) => Number(value.match(/-(\d+)(?:\/|$)/)?.[1] ?? 0);
  const node = (value) => value.match(/\/([A-Z0-9]{6})$/)?.[1] ?? '';
  assert.equal(sequence(result.secondDefect), sequence(result.firstDefect) + 1);
  assert.equal(sequence(result.secondExternal), sequence(result.firstExternal) + 1);
  assert.equal(result.uniqueIds, true);
  assert.equal(result.persistedDefectSeq, sequence(result.secondDefect));
  assert.equal(result.persistedExternalSeq, sequence(result.secondExternal));
  assert.equal(sequence(otherDeviceDefect), sequence(result.firstDefect));
  assert.notEqual(node(otherDeviceDefect), node(result.firstDefect));
  assert.notEqual(otherDeviceDefect, result.firstDefect, 'offline devices must not issue the same human document number');
  await otherCtx.close();
  await ctx.close();
});

test('#5/#6 — server role overrides cached privileges and offline mode cannot elevate with a shared PIN', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => {
    const out = {};
    out.startsAsWorker = currentRole === 'rabotnik';
    const state = serializeAppState();
    out.rolePersisted = state.currentRole === 'rabotnik';
    window.treshkaServerRole = () => 'worker';
    currentRole = 'admin';
    out.serverRoleOverridesCachedAdmin = applyAppState({ ...state, currentRole: 'admin' }) && currentRole === 'rabotnik';
    delete window.treshkaServerRole;
    currentRole = 'admin';
    requestRoleSwitch('rabotnik');
    out.rabotnikNoPinNeeded = currentRole === 'rabotnik';

    currentRole = 'rabotnik';
    out.elevationRejected = requestRoleSwitch('admin') === false && currentRole === 'rabotnik';
    out.pinSheetAbsent = document.getElementById('rolePinInput') === null;
    out.legacyConfirmRejected = confirmRoleSwitch('admin') === false && currentRole === 'rabotnik';
    out.noEmbeddedPin = Object.keys(ROLE_PINS).length === 0;

    currentRole = 'rabotnik';
    let toastMsg = '';
    const origToast = toast;
    window.toast = (m) => { toastMsg = m; origToast(m); };
    exportStockExcel();
    out.exportBlockedAtFunctionLevel = toastMsg.includes('🔒');
    window.toast = origToast;

    go('more');
    out.exportCardHiddenInMenu = !document.getElementById('content').innerHTML.includes('exportStockExcel()');
    currentRole = 'admin';
    go('more');
    out.exportCardShownForAdmin = document.getElementById('content').innerHTML.includes('exportStockExcel()');

    return out;
  });
  for (const [k, v] of Object.entries(r)) assert.equal(v, true, `expected ${k} to be true`);
  await ctx.close();
});

test('#3 — xlsx export uses the native file bridge and reports real success/failure', async () => {
  const { ctx, page } = await newPage(() => {
    window.__savedFiles = [];
    window.__fileSaveShouldSucceed = true;
    window.AndroidFiles = {
      saveExportedFile: (base64, filename, mime) => {
        window.__savedFiles.push({ filename, mime, len: base64.length });
        return window.__fileSaveShouldSucceed;
      },
    };
  });
  const ok = await page.evaluate(() => {
    const result = exportInventoryExcel();
    return { result, saved: window.__savedFiles, toast: document.getElementById('toast').textContent };
  });
  assert.equal(ok.saved.length, 1);
  assert.ok(ok.toast.includes('сохранён'), 'success message must reflect real native save');

  const fail = await page.evaluate(() => {
    window.__fileSaveShouldSucceed = false;
    window.__savedFiles = [];
    const result = exportInventoryExcel();
    return { result, toast: document.getElementById('toast').textContent };
  });
  assert.equal(fail.result, false, 'must propagate native save failure, not report success');
  assert.ok(!fail.toast.includes('скачан') && !fail.toast.includes('сохранён'),
    'must not claim success ("скачан"/"сохранён") when the native bridge rejected the save');
  await ctx.close();
});

test('#4 — printing routes through the native print bridge when available', async () => {
  const { ctx, page } = await newPage(() => {
    window.__printCalls = [];
    window.AndroidPrint = { printHtml: (html, job) => { window.__printCalls.push({ job, len: html.length }); } };
  });
  const r = await page.evaluate(() => { printLabel('flux'); return { calls: window.__printCalls }; });
  assert.equal(r.calls.length, 1);
  assert.ok(r.calls[0].len > 0);
  await ctx.close();
});

test('#4 — printing falls back to a real browser popup outside the Android wrapper', async () => {
  const { ctx, page } = await newPage();
  let popupOpened = false;
  page.on('popup', () => { popupOpened = true; });
  await page.evaluate(() => { printLabel('flux'); });
  await page.waitForTimeout(250);
  assert.equal(popupOpened, true);
  await ctx.close();
});

test('regression — QR label print HTML fits within one physical page (mm-sized content, no oversized px image)', async () => {
  const { ctx, page } = await newPage(() => {
    window.__printCalls = [];
    window.AndroidPrint = { printHtml: (html, job) => { window.__printCalls.push({ job, html }); } };
  });
  const r = await page.evaluate(() => { printLabel('flux'); return window.__printCalls[0]; });
  // Раньше этикетка была вёрстана в px (img 180x180 + padding:24px) при
  // физической странице @page 60mm x 40mm — контент был в разы выше страницы,
  // и Chromium честно паджинировал его на 3-4 листа. Фикс переводит всю
  // вёрстку этикетки в мм, гарантированно укладывающиеся в рабочую область.
  assert.ok(r.html.includes('size:60mm 40mm'), 'label must still target a 60x40mm physical page');
  assert.ok(r.html.includes('width:22mm'), 'QR image must be sized in mm to fit the declared page');
  assert.ok(!/width:180px/.test(r.html), 'must not regress to the old oversized px image that overflowed the page');
  await ctx.close();
});

test('#photo — item photo can be attached/replaced/removed via the native AndroidPhoto bridge, gated by role', async () => {
  const { ctx, page } = await newPage(() => {
    window.__photoBridgeCalls = [];
    window.AndroidPhoto = { pickPhoto: (id) => { window.__photoBridgeCalls.push(id); } };
  });
  const r = await page.evaluate(() => {
    const out = {};
    // Работник не может прикреплять фото — мост даже не вызывается.
    currentRole = 'rabotnik';
    requestItemPhoto('flux');
    out.blockedForRabotnik = window.__photoBridgeCalls.length === 0;

    // Администратор — мост вызывается с id товара.
    currentRole = 'admin';
    requestItemPhoto('flux');
    out.bridgeCalledForAdmin = window.__photoBridgeCalls[0] === 'flux';

    // Асинхронный callback из Android (или browser-fallback) сохраняет фото в модели
    // и его видно в разметке карточки товара.
    window.onPhotoPicked('flux', 'data:image/jpeg;base64,AAAA', null);
    out.photoStored = item('flux').photo === 'data:image/jpeg;base64,AAAA';
    openItem('flux');
    out.photoInMarkup = document.getElementById('content').innerHTML.includes('data:image/jpeg;base64,AAAA');

    // Удаление фото очищает поле и убирает <img> из карточки.
    removeItemPhoto('flux');
    out.photoCleared = item('flux').photo == null;
    out.imgGoneFromMarkup = !document.getElementById('content').innerHTML.includes('data:image/jpeg;base64,AAAA');
    return out;
  });
  assert.equal(r.blockedForRabotnik, true);
  assert.equal(r.bridgeCalledForAdmin, true);
  assert.equal(r.photoStored, true);
  assert.equal(r.photoInMarkup, true);
  assert.equal(r.photoCleared, true);
  assert.equal(r.imgGoneFromMarkup, true);
  await ctx.close();
});

test('#8 — native back handler drives the JS navigation stack (sheet > sklad drill-down > tab > root)', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => {
    const out = {};
    go('sklad');
    out.atRootReturnsFalse = __handleNativeBack() === false;

    goSklad(['Комплектующие']);
    goSklad(['Комплектующие', 'Кабели']);
    out.deepInSkladReturnsTrue = __handleNativeBack() === true;
    out.pathAfterOneBack = skladPath.slice();

    go('docs');
    out.otherTabReturnsTrue = __handleNativeBack() === true;
    out.tabAfterBack = currentTab;

    go('sklad');
    openPlusMenu();
    out.sheetOpenBeforeBack = document.getElementById('sheetLayer').innerHTML.trim().length > 0;
    out.sheetClosesOnBackFirst = __handleNativeBack() === true;
    out.sheetEmptyAfterBack = document.getElementById('sheetLayer').innerHTML.trim().length === 0;
    return out;
  });
  assert.equal(r.atRootReturnsFalse, true, 'at the top level, native back should let Android close/minimize');
  assert.equal(r.deepInSkladReturnsTrue, true);
  assert.deepEqual(r.pathAfterOneBack, ['Комплектующие']);
  assert.equal(r.otherTabReturnsTrue, true);
  assert.equal(r.tabAfterBack, 'sklad');
  assert.equal(r.sheetOpenBeforeBack, true);
  assert.equal(r.sheetClosesOnBackFirst, true, 'an open sheet/modal must close before touching nav state');
  assert.equal(r.sheetEmptyAfterBack, true);
  await ctx.close();
});

test('regression — QR changes with the SKU while the scanner remains backward-compatible with legacy internal-id labels', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => {
    const i = items.find((x) => x.id === 'flux');
    const before = genQR(i.id);
    const oldSku = i.sku;
    i.sku = 'РМ-9999-NEW';
    const after = genQR(i.id);
    const encodesNewSku = qrValue(i).includes(i.sku) && !qrValue(i).includes(i.id);
    const legacyCodeStillResolves = items.find((x) => x.id === i.id) === i;
    i.sku = oldSku;
    return { imageChanged: before !== after, encodesNewSku, legacyCodeStillResolves };
  });
  assert.equal(r.imageChanged, true);
  assert.equal(r.encodesNewSku, true);
  assert.equal(r.legacyCodeStillResolves, true);
  await ctx.close();
});

test('regression — role-scoped documents: rabotnik only sees their own post\'s docs', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => {
    currentRole = 'rabotnik';
    currentUserPost = 'ТЭЧ';
    const visible = docs.filter(canSeeDoc);
    const allSamePost = visible.every((d) => d.post === 'ТЭЧ');
    const someOtherPostHidden = docs.some((d) => d.post && d.post !== 'ТЭЧ' && !canSeeDoc(d));
    currentRole = 'admin';
    return { allSamePost, someOtherPostHidden, hasAnyVisible: visible.length > 0 };
  });
  assert.equal(r.allSamePost, true);
  assert.equal(r.someOtherPostHidden, true);
  assert.equal(r.hasAnyVisible, true);
  await ctx.close();
});

test('regression — small-screen layout: bottom nav stays within the viewport', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(PROTOTYPE_URL);
  await page.waitForTimeout(250);
  const r = await page.evaluate(() => {
    const nav = document.querySelector('.nav');
    const rect = nav.getBoundingClientRect();
    return { navBottom: rect.bottom, viewportH: window.innerHeight, scrollH: document.documentElement.scrollHeight };
  });
  assert.ok(r.navBottom <= r.viewportH + 1, 'bottom nav must stay within the visible viewport');
  assert.ok(r.scrollH <= r.viewportH + 1, 'app container must not force whole-page scrolling');
  await ctx.close();
});

test('regression — app version is shown to the user on the "Ещё" screen', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => {
    render({ fn: views.more });
    return { version: APP_VERSION, html: document.getElementById('content').innerHTML };
  });
  assert.equal(r.version, '1.6');
  assert.ok(r.html.includes('версия 1.6'), 'more() screen must render the current app version');
  await ctx.close();
});

test('regression — app version is also shown in the persistent top masthead on every screen', async () => {
  const { ctx, page } = await newPage();
  const text = await page.evaluate(() => document.getElementById('mastVersion').textContent);
  assert.equal(text, 'v1.6');
  await ctx.close();
});

// Раньше каждое поле поиска на каждый ввод перерисовывало ВЕСЬ экран
// ($('content').innerHTML = ...), что уничтожало старый <input> — включая
// тот, на который указывает `this` внутри oninput. this.focus() после этого
// выполнялся на уже отсоединённом от DOM узле — молча ничего не делал, и
// клавиатура закрывалась сразу после первого введённого символа (дописать
// слово было невозможно). Тест дублирует реальный ввод посимвольно через
// page.type(), а не устанавливает значение целиком — иначе баг не
// воспроизвести: физический ввод на реальном устройстве и есть посимвольный.
for (const [screen, inputId, text] of [
  ['posts', 'postsSearchInput', 'ТЭЧ'],
  ['docs', 'docsSearchInput', 'ДР-01'],
  ['ext', 'extSearchInput', 'Иванов'],
]) {
  test(`regression — "${screen}" search input keeps focus while typing (was closing the keyboard after 1 char)`, async () => {
    const { ctx, page } = await newPage();
    await page.evaluate((s) => { currentRole = 'admin'; go(s); }, screen);
    await page.click('#' + inputId);
    await page.type('#' + inputId, text, { delay: 25 });
    const value = await page.inputValue('#' + inputId);
    assert.equal(value, text, `expected full string to be typed into #${inputId}, got "${value}"`);
    await ctx.close();
  });
}

test('regression — sklad-wide search input keeps focus while typing (was closing the keyboard after 1 char)', async () => {
  const { ctx, page } = await newPage();
  await page.evaluate(() => go('sklad'));
  await page.click('#globalSearchInput');
  await page.type('#globalSearchInput', 'флюс', { delay: 25 });
  const value = await page.inputValue('#globalSearchInput');
  assert.equal(value, 'флюс');
  await ctx.close();
});

test('regression — "add material" button in an open work act stays on-screen and works (was clipped off-screen)', async () => {
  // Раньше <select> внутри .addmat (flex-строка: выбор товара + количество +
  // кнопка "＋") не сжимался уже длиннее своего содержимого — длинное
  // название товара раздвигало всю строку шире экрана, а .content/.phone/body
  // обрезают переполнение по горизонтали (overflow:hidden), так что кнопка
  // "＋" уезжала за пределы видимой области: количество ввести можно было,
  // подтвердить — нечем. Тест на узком экране (как на реальном телефоне)
  // проверяет, что кнопка физически видна В ПРЕДЕЛАХ вьюпорта, а не просто
  // существует в DOM, и что клик по ней реально добавляет материал в акт.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(PROTOTYPE_URL);
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    currentRole = 'admin';
    const idx = docs.findIndex((d) => d.no === 'АВР-145');
    openDoc(idx);
  });
  await page.waitForTimeout(150);
  const before = await page.evaluate(() => docs.find((d) => d.no === 'АВР-145').materials.length);
  const buttonBox = await page.evaluate(() => {
    // Акт теперь содержит ДВЕ строки .addmat (типовые работы + материалы) —
    // явно берём материальную (.addmat-materials), иначе тест может
    // случайно проверить/кликнуть по кнопке добавления работы.
    const btn = document.querySelector('.addmat-materials button');
    const r = btn.getBoundingClientRect();
    return { right: r.right, viewportW: window.innerWidth, visible: r.width > 0 && r.height > 0 };
  });
  assert.ok(buttonBox.visible, '"＋" button must actually be rendered with non-zero size');
  assert.ok(
    buttonBox.right <= buttonBox.viewportW + 1,
    `"＋" button must stay within the ${buttonBox.viewportW}px viewport, was at right=${buttonBox.right}`,
  );
  // 'battnrtk' (Аккумулятор тяговый НРТК) ещё НЕ в списке материалов этого
  // акта, но 2 шт доступны на посту "НРТК" (см. posts.stock в демо-данных) —
  // addMat() добавит НОВУЮ строку в materials[], что и проверяем ниже по
  // росту длины массива. Если бы товар уже был в акте, addMat() просто
  // увеличил бы q существующей строки, не меняя длину массива, — поэтому
  // важно взять товар, которого в акте ещё нет.
  await page.selectOption('#addSel', 'battnrtk');
  await page.fill('#addQty', '1');
  await page.click('.addmat-materials button');
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => docs.find((d) => d.no === 'АВР-145').materials.length);
  assert.equal(after, before + 1, 'clicking the on-screen "＋" button must actually add the material to the act');
  await ctx.close();
});

test('regression — exported act filename is human-readable (act number, date, action type), not the bare doc code', async () => {
  const { ctx, page } = await newPage(() => {
    window.__savedFiles = [];
    window.AndroidFiles = {
      saveExportedFile: (...args) => { window.__savedFiles.push(args[1]); return true; },
    };
    window.__printCalls = [];
    window.AndroidPrint = { printHtml: (html, job) => { window.__printCalls.push(job); } };
  });
  const r = await page.evaluate(() => {
    exportWorkActExcel('АВР-145');
    printDoc('АВР-145');
    printDoc('ДФ-041'); // акт дефектовки — тоже должен получить читаемое имя, без типа действия
    return { xlsxName: window.__savedFiles[0], pdfJob: window.__printCalls[0], defektJob: window.__printCalls[1] };
  });
  assert.equal(r.xlsxName, 'Акт выполненных работ №145 от 17.07.2026 ремонт.xlsx',
    'xlsx filename must be derived from the act number/date/action type, not just "АВР-145.xlsx"');
  assert.equal(r.pdfJob, 'Акт выполненных работ №145 от 17.07.2026 ремонт',
    'print job name (used as the suggested PDF filename) must be human-readable');
  assert.equal(r.defektJob, 'Акт дефектовки №041 от 16.07.2026',
    'дефектовочный акт has no action type and must not have one appended to its filename');
  await ctx.close();
});

test('regression — work-act "Тип действия"/"Наименование работ"/"Результат"/"ОТК" fields are wired end-to-end', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => {
    const d = docs.find((x) => x.no === 'АВР-147'); // черновик с одним типом действия, ещё не закрыт
    const beforeStatus = actResultStatus(d.actionTypes);
    toggleActionType(d.no, 'Модернизация'); // теперь два типа: Диагностика + Модернизация
    const afterStatus = actResultStatus(d.actionTypes);
    const worksBefore = d.works.length;
    d.works.push({ type: 'test-op', qty: 3 });
    removeWork(d.no, d.works.length - 1);
    const worksAfterRemove = d.works.length;
    setResultText(d.no, 'проверка результата');
    const otkBefore = d.otkPassed;
    toggleOtk(d.no);
    const otkAfter = d.otkPassed;
    return { beforeStatus, afterStatus, worksBefore, worksAfterRemove, resultText: d.resultText, otkBefore, otkAfter };
  });
  assert.equal(r.beforeStatus, 'проведена диагностика');
  assert.equal(r.afterStatus, 'проведена диагностика и модернизировано',
    'multiple action types must combine their statuses joined by "и"');
  assert.equal(r.worksAfterRemove, r.worksBefore, 'removeWork must remove exactly the row that addWork/push added');
  assert.equal(r.resultText, 'проверка результата', 'setResultText must persist the manually-typed result line');
  assert.notEqual(r.otkAfter, r.otkBefore, 'toggleOtk must flip otkPassed');
  await ctx.close();
});

test('regression — closing a work act requires at least one "Тип действия" to be selected', async () => {
  const { ctx, page } = await newPage(() => {
    window.__toasts = [];
  });
  const r = await page.evaluate(() => {
    const d = docs.find((x) => x.no === 'АВР-144'); // уже закрыт в демо-данных — берём его форму как рабочий акт
    const clone = { ...JSON.parse(JSON.stringify(d)), no: 'АВР-TEST-NOACTION', status: 'Черновик', actionTypes: [] };
    docs.push(clone);
    closeWork('АВР-TEST-NOACTION');
    const stillDraft = docs.find((x) => x.no === 'АВР-TEST-NOACTION').status === 'Черновик';
    const toastMsg = document.getElementById('toast').textContent;
    docs.pop();
    return { stillDraft, toastMsg };
  });
  assert.equal(r.stillDraft, true, 'closeWork must refuse to close an act with no action type selected');
  assert.ok(r.toastMsg.includes('тип действия'), 'must explain via toast that an action type is required');
  await ctx.close();
});

test('regression — schema migration v1→v3 preserves old data and backfills work/photo fields', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => {
    const base = JSON.parse(JSON.stringify(serializeAppState()));
    const legacy = JSON.parse(JSON.stringify(base));
    legacy.schemaVersion = 1;
    legacy.docs = legacy.docs.map((d) => {
      if (d.kind !== 'work') return d;
      const rest = { ...d };
      delete rest.actionTypes;
      delete rest.resultText;
      delete rest.otkPassed;
      return { ...rest, works: (d.works || []).map((w) => w.type) }; // старый формат: works — массив строк
    });
    const migrated = migrateAppState(legacy);
    const workDoc = migrated && migrated.docs.find((d) => d.kind === 'work');
    return {
      migratedOk: migrated !== null,
      schemaVersion: migrated && migrated.schemaVersion,
      hasActionTypes: Array.isArray(workDoc && workDoc.actionTypes),
      resultTextIsString: typeof (workDoc && workDoc.resultText) === 'string',
      otkPassedIsBool: typeof (workDoc && workDoc.otkPassed) === 'boolean',
      firstWorkIsObject: workDoc && typeof workDoc.works[0] === 'object' && 'type' in workDoc.works[0] && 'qty' in workDoc.works[0],
    };
  });
  assert.equal(r.migratedOk, true, 'v1 data must migrate cleanly to the current schema');
  assert.equal(r.schemaVersion, 4);
  assert.equal(r.hasActionTypes, true, 'migration must backfill actionTypes:[] where missing');
  assert.equal(r.resultTextIsString, true, 'migration must backfill resultText:\'\' where missing');
  assert.equal(r.otkPassedIsBool, true, 'migration must backfill otkPassed:false where missing');
  assert.equal(r.firstWorkIsObject, true, 'migration must convert legacy string work entries to {type, qty:1} objects');
  await ctx.close();
});

test('v1.3 — application photo is stored in the defect card and automatically attached to the work act by reference', async () => {
  const { ctx, page } = await newPage(() => {
    window.__photoBridgeCalls = [];
    window.AndroidPhoto = { pickPhoto: (target) => window.__photoBridgeCalls.push(target) };
  });
  const r = await page.evaluate(() => {
    currentRole = 'admin';
    views.newDefekt();
    requestDefektApplicationPhoto();
    const target = window.__photoBridgeCalls[0];
    const photo = 'data:image/jpeg;base64,ZmFrZS1hcHBsaWNhdGlvbi1waG90bw==';
    window.onPhotoPicked(target, photo, null);
    const previewShown = !!document.querySelector('#defektPhotoBox img');

    document.getElementById('f_order').value = 'З-TEST-PHOTO';
    document.getElementById('f_item_name').value = 'Тестовое изделие';
    document.getElementById('f_serial').value = '123456';
    document.getElementById('f_date').value = '22.07.2026';
    document.getElementById('f_from').value = 'Тестовое подразделение';
    document.getElementById('f_post').value = posts[0].name;
    document.getElementById('f_callsign').value = 'Тест';
    document.getElementById('f_fault').value = 'Тестовая неисправность';
    document.getElementById('f_defects').value = 'Тестовый дефект';
    document.getElementById('f_verdict').value = 'Ремонтопригодно';
    submitDefekt();

    const defekt = docs.find((d) => d.kind === 'defekt' && d.orderNo === 'З-TEST-PHOTO');
    createWorkFromDefekt(defekt.no);
    const work = docs.find((d) => d.kind === 'work' && d.defektDoc === defekt.no);
    renderWorkDoc(work);
    const attachedInWorkCard = !!document.querySelector('.doc-photo img[src^="data:image/jpeg"]');
    const serialized = JSON.stringify(serializeAppState());
    const encodedPayload = 'ZmFrZS1hcHBsaWNhdGlvbi1waG90bw==';
    const storedCopies = serialized.split(encodedPayload).length - 1;
    return {
      target,
      previewShown,
      defektHasPhoto: defekt.applicationPhoto === photo,
      workSource: work.applicationPhotoSource,
      resolvedPhoto: workApplicationPhoto(work),
      attachedInWorkCard,
      storedCopies,
    };
  });
  assert.equal(r.target, '__defekt_application_photo__', 'photo picker must receive the dedicated defect-draft target');
  assert.equal(r.previewShown, true, 'selected application photo must be previewed before the defect is submitted');
  assert.equal(r.defektHasPhoto, true, 'the photo must be stored in the created defect card');
  assert.ok(r.workSource && r.workSource.startsWith('ДФ-'), 'work act must retain an explicit reference to the source defect photo');
  assert.ok(r.resolvedPhoto.startsWith('data:image/jpeg'), 'work act must resolve the photo through its linked defect');
  assert.equal(r.attachedInWorkCard, true, 'work-act card must visibly render the inherited application photo');
  assert.equal(r.storedCopies, 1, 'Base64 photo payload must be stored once, not duplicated into the work act');
  await ctx.close();
});

// Читает записи из ZIP, собранного buildZipStore() (метод STORE — без сжатия),
// без внешних зависимостей: раз данные не сжаты, можно просто пройти по
// локальным заголовкам и вырезать байты содержимого напрямую.
function readStoreZipEntries(buf) {
  const entries = {};
  let pos = 0;
  while (pos + 4 <= buf.length && buf.readUInt32LE(pos) === 0x04034b50) {
    const compression = buf.readUInt16LE(pos + 8);
    const compSize = buf.readUInt32LE(pos + 18);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const nameStart = pos + 30;
    const name = buf.toString('utf8', nameStart, nameStart + nameLen);
    const dataStart = nameStart + nameLen + extraLen;
    entries[name] = { compression, data: buf.subarray(dataStart, dataStart + compSize) };
    pos = dataStart + compSize;
  }
  return entries;
}

test('regression — exportWorkActDocx() produces a real, valid, parseable .docx (not a fake/renamed file)', async () => {
  const { ctx, page } = await newPage(() => {
    window.AndroidFiles = {
      saveExportedFile: (base64, filename, mime) => {
        window.__docxBase64 = base64;
        window.__docxFilename = filename;
        window.__docxMime = mime;
        return true;
      },
    };
  });
  const r = await page.evaluate(() => {
    const ok = exportWorkActDocx('АВР-145');
    return { ok, base64: window.__docxBase64, filename: window.__docxFilename, mime: window.__docxMime };
  });
  assert.equal(r.ok, true, 'exportWorkActDocx must report success when the native save bridge accepts the file');
  assert.equal(r.mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(r.filename, 'Акт выполненных работ №145 от 17.07.2026 ремонт.docx');

  const buf = Buffer.from(r.base64, 'base64');
  // Валидный ZIP заканчивается записью "End Of Central Directory" (PK\x05\x06).
  assert.ok(buf.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])), 'must be a real ZIP container with a valid End-Of-Central-Directory record');

  const entries = readStoreZipEntries(buf);
  assert.ok(entries['[Content_Types].xml'], 'ZIP must contain [Content_Types].xml');
  assert.ok(entries['_rels/.rels'], 'ZIP must contain _rels/.rels');
  assert.ok(entries['word/document.xml'], 'ZIP must contain word/document.xml');
  Object.values(entries).forEach(e => assert.equal(e.compression, 0, 'all entries must use STORE (no compression), matching what the ZIP writer claims'));

  const docXml = entries['word/document.xml'].data.toString('utf8');
  // Заголовок теперь в 3 строки (АКТ №.../выполненных работ/от «...»), а не
  // одной строкой "АКТ ВЫПОЛНЕННЫХ РАБОТ №145" — см. ревью по образцу.
  assert.ok(docXml.includes('АКТ №145'), 'document.xml must contain the "АКТ №..." title line');
  assert.ok(docXml.includes('выполненных работ'), 'document.xml must contain the "выполненных работ" title line');
  assert.ok(docXml.includes('«17» июля 2026 г.'), 'document.xml must contain the long-form Russian date');
  assert.ok(docXml.includes('Ремонт'), 'document.xml must contain the selected action type');
  assert.ok(docXml.includes('1. Результат выполненных работ: произведено:'), 'document.xml must contain the numbered result heading');
  assert.ok(docXml.includes('- отремонтировано'), 'document.xml must contain the auto-derived result status as a bullet line');
  assert.ok(docXml.includes('Выполнены следующие работы:'), 'document.xml must contain the introductory line from the supplied template');
  assert.ok(docXml.includes('Герасимчук'), 'document.xml must contain the fixed "Передал" signer');
  assert.ok(/Передал:<\/w:t>[\s\S]*?<\/w:tr><w:tr>[\s\S]*?Командир ремонтного взвода/.test(docXml), 'signature headings and positions must be in separate table rows');
  assert.ok(docXml.includes('ОТК пройдено ответственный командир отделения ремонтного поста'), 'document.xml must contain the fixed blank OTK signature line');
  assert.ok(docXml.includes('Флюс паяльный ТТ'), 'document.xml must list the act\'s materials table (from d.materials)');
  assert.ok(docXml.includes('арт. РМ-0012'), 'material article must be folded into the material name (sample has no separate 4th column)');
  // Весь текст должен быть Times New Roman 14pt (w:sz/w:szCs=28), не только заголовок.
  assert.ok(docXml.includes('Times New Roman'), 'document.xml must set Times New Roman explicitly');
  assert.ok((docXml.match(/w:sz w:val="28"/g) || []).length > 5, 'the 14pt (w:sz=28) size must be applied throughout the document, not just the title');
  // Таблицы должны иметь закреплённые ширины колонок (tblLayout fixed), а не
  // пустой tblGrid, который Word мог бы перераспределить по содержимому.
  assert.ok(docXml.includes('w:type="fixed"'), 'work/materials tables must use a fixed table layout with explicit column widths');
  assert.ok((docXml.match(/w:gridSpan w:val="3"/g) || []).length >= 2, 'both the works and materials tables must have the merged descriptive row');
  // Блок подписей — двухколоночный, БЕЗ рамок (ревью #6).
  assert.ok(/w:val="none"[\s\S]{0,40}w:sz="0"/.test(docXml), 'the signature table must use explicit "none" borders (borderless two-column layout)');
  // ZIP должен содержать styles.xml с Times New Roman 14pt по умолчанию — подстраховка,
  // если где-то run без явного rPr.
  assert.ok(entries['word/styles.xml'], 'ZIP must contain word/styles.xml with docDefaults');
  assert.ok(entries['word/_rels/document.xml.rels'], 'ZIP must relate document.xml to styles.xml');
  await ctx.close();
});

test('regression — the updated PDF/print form for a work act matches the new template (not the old bare materials-only layout)', async () => {
  const { ctx, page } = await newPage(() => {
    window.__printCalls = [];
    window.AndroidPrint = { printHtml: (html, job) => { window.__printCalls.push({ job, html }); } };
  });
  const r = await page.evaluate(() => { printDoc('АВР-145'); return window.__printCalls[0]; });
  assert.equal(r.job, 'Акт выполненных работ №145 от 17.07.2026 ремонт');
  assert.ok(r.html.includes('АКТ №145'), 'print form must show the "АКТ №..." title line');
  assert.ok(r.html.includes('выполненных работ'), 'print form must show the "выполненных работ" title line');
  assert.ok(r.html.includes('«17» июля 2026 г.'), 'print form must show the long-form Russian date');
  assert.ok(r.html.includes('Ремонт'), 'print form must show the selected action type(s) in the merged header row');
  assert.ok(r.html.includes('Наименование работ'), 'print form must include the "Наименование работ" table');
  assert.ok(r.html.includes('Выполнены следующие работы:'), 'print form must include the introductory line from the Word template');
  assert.ok(r.html.includes('№ п/п'), 'print form work/materials tables must include the "№ п/п" column (was missing before)');
  assert.ok(r.html.includes('Сборочные работы'), 'print form must list the act\'s works (from d.works)');
  assert.ok(r.html.includes('арт. РМ-0012'), 'print form materials table must fold the article into the material name, matching the 3-column sample');
  assert.ok(r.html.includes('1. Результат выполненных работ: произведено:'), 'print form must show the numbered result heading');
  assert.ok(r.html.includes('- отремонтировано'), 'print form must show the auto-derived result status as a bullet line');
  assert.ok(r.html.includes('ОТК пройдено ответственный командир отделения ремонтного поста'), 'print form must include the fixed blank OTK signature line');
  assert.ok(r.html.includes('Герасимчук'), 'print form must include the fixed "Передал" signer');
  assert.equal((r.html.match(/class="mergedrow"/g) || []).length, 2, 'both the works and materials tables must contain the merged descriptive row');
  assert.ok(r.html.includes('(подпись)'), 'signature block must have separate signature/name rows, matching the Word template');
  assert.ok(r.html.includes('Times New Roman'), 'print form must use Times New Roman, matching the .docx export');
  assert.ok(r.html.includes('14pt'), 'print form must use 14pt text, matching the .docx export');
  assert.ok(r.html.includes('size:A4'), 'print form @page must target A4, matching the .docx page size');
  await ctx.close();
});

test('Android printing uses native 60x40 media and does not double the CSS A4 margins', () => {
  const mainActivity = readFileSync(path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', 'android', 'app', 'src', 'main', 'java', 'com', 'treshka', 'sklad', 'MainActivity.kt',
  ), 'utf8');
  assert.ok(mainActivity.includes('TRESHKA_LABEL_60X40'), 'label printing must use an explicit custom media size');
  assert.ok(mainActivity.includes('2362') && mainActivity.includes('1575'), 'custom label media must be 60x40 mm in mils');
  assert.ok(mainActivity.includes('PrintAttributes.Margins.NO_MARGINS'), 'native margins must stay zero because CSS owns document margins');
  assert.ok(mainActivity.includes('resolver.delete(uri, null, null)'), 'a failed MediaStore export must clean up its pending URI');
  assert.ok(mainActivity.includes('resolver.update(uri, values, null, null) > 0'), 'export success must require the pending file to be published');
});

test('regression — the PDF/print form for a дефектовка act stays on its own simple layout (unaffected by the work-act template change)', async () => {
  const { ctx, page } = await newPage(() => {
    window.__printCalls = [];
    window.AndroidPrint = { printHtml: (html, job) => { window.__printCalls.push({ job, html }); } };
  });
  const r = await page.evaluate(() => { printDoc('ДФ-041'); return window.__printCalls[0]; });
  assert.equal(r.job, 'Акт дефектовки №041 от 16.07.2026');
  assert.ok(r.html.includes('Акт дефектовки ДФ-041'), 'defekt print form must keep its own simple title');
  assert.ok(!r.html.includes('Наименование работ'), 'defekt acts have no works table and must not show the work-act template section');
  await ctx.close();
});

test('regression — closing a work act decrements the specific post-level lots, not just the post total', async () => {
  // Раньше performWorkClose() уменьшал только общий остаток поста (s.q), а
  // вложенные партии (s.lots) оставались нетронутыми — сумма партий переставала
  // сходиться с фактическим остатком (отчёт по партиям/срокам годности "врал").
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => {
    const p = posts.find((x) => x.name === 'НРТК');
    const stockEntry = p.stock.find((s) => s.id === 'battnrtk');
    stockEntry.q = 2;
    stockEntry.lots = [{ lot: 'Л-СТАРАЯ', q: 1, exp: '01.2026' }, { lot: 'Л-НОВАЯ', q: 1, exp: '01.2027' }];

    const clone = JSON.parse(JSON.stringify(docs.find((d) => d.no === 'АВР-145')));
    clone.no = 'АВР-TEST-LOTS';
    clone.status = 'Ожидает приёмки на склад';
    clone.post = 'НРТК';
    clone.itemId = null; // не связываем с конкретным изделием — тест только про партии материала
    clone.materials = [{ id: 'battnrtk', q: 1 }];
    docs.push(clone);

    currentRole = 'kladovshik';
    performWorkClose(clone);

    const after = p.stock.find((s) => s.id === 'battnrtk');
    const lotsSum = (after ? after.lots || [] : []).reduce((a, l) => a + l.q, 0);
    const result = {
      postQtyAfter: after ? after.q : null,
      lotsAfter: after ? after.lots : null,
      lotsSum,
    };
    docs.pop();
    return result;
  });
  assert.equal(r.postQtyAfter, 1, 'post-level total quantity must be decremented by the consumed amount');
  assert.ok(r.lotsAfter && r.lotsAfter.length === 1 && r.lotsAfter[0].lot === 'Л-НОВАЯ',
    'the FIFO-consumed lot ("Л-СТАРАЯ") must be fully removed once its quantity reaches 0, leaving only the untouched lot');
  assert.equal(r.lotsSum, r.postQtyAfter, 'the sum of remaining post-level lots must match the post-level total (they must not drift apart)');
  await ctx.close();
});

test('regression — applyAppState() is atomic: a malformed non-array field must not leave items/posts/docs partially replaced', async () => {
  // Раньше items/posts/docs уже заменялись (items.length=0; items.push(...)),
  // пока extIssues/auditLog ещё не были проверены — spread по некорректному
  // полю бросал исключение, и state оставался ЧАСТИЧНО применённым (новые
  // items/posts/docs, но старые extIssues/auditLog), при этом функция всё
  // равно возвращала false, маскируя то, что состояние уже искажено.
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => {
    const base = JSON.parse(JSON.stringify(serializeAppState()));
    const itemsBefore = JSON.stringify(items);
    const docsBefore = JSON.stringify(docs);
    const postsBefore = JSON.stringify(posts);

    const malformed = { ...base, items: [{ id: 'fake-item-should-not-apply' }], extIssues: 'НЕ МАССИВ — специально сломано' };
    const ok = applyAppState(malformed);

    return {
      ok,
      itemsUnchanged: JSON.stringify(items) === itemsBefore,
      docsUnchanged: JSON.stringify(docs) === docsBefore,
      postsUnchanged: JSON.stringify(posts) === postsBefore,
    };
  });
  assert.equal(r.ok, false, 'applyAppState must report failure when any field is malformed');
  assert.equal(r.itemsUnchanged, true, 'items must NOT be partially replaced when a later field (extIssues) fails validation');
  assert.equal(r.docsUnchanged, true, 'docs must remain untouched (atomicity)');
  assert.equal(r.postsUnchanged, true, 'posts must remain untouched (atomicity)');
  await ctx.close();
});

test('regression — rabotnik can never reassign their bound post locally, including through the legacy PIN path', async () => {
  // Раньше <select id="postSwitchSelect"> менял currentUserPost НАПРЯМУЮ по
  // onchange — работник мог сам назначить себя на любой пост, полностью
  // обходя ограничение canSeeDoc()/isRabotnikRestrictedToPost().
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => {
    currentRole = 'rabotnik';
    currentUserPost = 'ТЭЧ';
    views.roles();
    const otherPost = posts.find((p) => p.name !== 'ТЭЧ').name;
    const requestResult = requestPostSwitch(otherPost);
    const postAfterRequest = currentUserPost;
    const sheetAbsent = !document.querySelector('#postPinInput');
    const confirmResult = confirmPostSwitch(otherPost);
    return { requestResult, confirmResult, postAfterRequest, sheetAbsent, otherPost };
  });
  assert.equal(r.requestResult, false);
  assert.equal(r.confirmResult, false);
  assert.equal(r.sheetAbsent, true, 'the removed PIN flow must not be rendered');
  assert.equal(r.postAfterRequest, 'ТЭЧ', 'only the server-side account assignment may change currentUserPost');
  await ctx.close();
});

test('review 800c0c9 — a 304 response reuses an immutable cached snapshot without parsing an empty body', async () => {
  const { ctx, page, counts } = await newHttpServerPage({ role: 'worker' });
  const result = await page.evaluate(async () => {
    items[0].stock = 99;
    await window.treshkaServerSync.flush();
    return {
      stock: items[0].stock,
      status: window.treshkaServerSync.status(),
    };
  });
  assert.ok(counts().stateGets >= 2, 'the explicit flush must exercise the 304 branch');
  assert.equal(result.stock, 5, 'worker-local drift must be replaced from the cached server graph');
  assert.equal(result.status.lastError, null);
  await ctx.close();
});

test('review 800c0c9 — a 413 response enters backoff instead of uploading every timer tick', async () => {
  const { ctx, page, counts } = await newHttpServerPage({ role: 'owner', putStatus: 413 });
  const result = await page.evaluate(async () => {
    auditLog.unshift({ action: 'oversized-local-change', detail: 'kept on device' });
    await window.treshkaServerSync.flush();
    const afterFailure = window.treshkaServerSync.status();
    await window.treshkaServerSync.flush();
    return {
      afterFailure,
      afterImmediateRetry: window.treshkaServerSync.status(),
      now: Date.now(),
    };
  });
  assert.equal(counts().statePuts, 1, 'backoff must suppress the immediate second upload');
  assert.ok(result.afterFailure.consecutiveFailures >= 1);
  assert.ok(result.afterFailure.nextAttemptAt >= result.now + 20_000);
  assert.match(result.afterFailure.lastError, /1,5 МБ/);
  await ctx.close();
});

test('review 1c9e809 — the complete local audit remains exportable while the uploaded window stays bounded', async () => {
  const { ctx, page, counts, putBodies } = await newHttpServerPage({ role: 'owner' });
  const localCount = await page.evaluate(async () => {
    auditLog.length = 0;
    for (let index = 0; index < 2_105; index += 1) {
      auditLog.push({ id: `audit-${index}`, action: 'Проверка границы' });
    }
    await window.treshkaServerSync.flush();
    return auditLog.length;
  });
  assert.equal(localCount, 2_105, 'bounded upload must not delete the local exportable journal');
  assert.equal(counts().statePuts, 1);
  assert.equal(putBodies[0].state.auditLog.length, 2_000);
  assert.equal(putBodies[0].partial, false);
  await ctx.close();
});

test('review 1c9e809 — worker projection is replaced before a promoted administrator may upload', async () => {
  const { ctx, page, counts, putBodies } = await newHttpServerPage({
    role: 'worker',
    promoteToRole: 'admin',
  });
  const result = await page.evaluate(async () => {
    items[0].stock = 0;
    await window.treshkaServerSync.flush();
    const afterPromotion = {
      stock: items[0].stock,
      partial: window.treshkaServerSync.status().partial,
      role: window.treshkaServerRole(),
    };
    items[0].stock = 6;
    await window.treshkaServerSync.flush();
    return afterPromotion;
  });
  assert.equal(result.role, 'admin');
  assert.equal(result.partial, false);
  assert.equal(result.stock, 5, 'full server truth must replace the old worker projection');
  assert.equal(counts().statePuts, 1, 'the partial graph itself must never be uploaded');
  assert.equal(putBodies[0].partial, false);
  assert.equal(putBodies[0].state.items[0].stock, 6);
  await ctx.close();
});

test('review 4968fed — authorization scope updates even when the server warehouse is empty', async () => {
  const { ctx, page, counts } = await newHttpServerPage({
    role: 'worker',
    promoteToRole: 'admin',
    emptyState: true,
  });
  const result = await page.evaluate(async () => {
    await window.treshkaServerSync.flush();
    return {
      role: window.treshkaServerRole(),
      status: window.treshkaServerSync.status(),
    };
  });
  assert.equal(result.role, 'admin');
  assert.equal(result.status.partial, false);
  assert.equal(counts().stateGets, 3, 'scope change without state must force an unconditional refetch');
  assert.equal(counts().statePuts, 0, 'an authorization-only response must not upload the old local graph');
  await ctx.close();
});

test('review 1c9e809 — overlapping 413 recovery reuses one embedded-photo migration', async () => {
  const { ctx, page, counts } = await newHttpServerPage({
    role: 'owner',
    putStatus: 413,
    embeddedPhoto: true,
    mediaDelayMs: 500,
  });
  for (let attempt = 0; attempt < 20 && counts().mediaPosts === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(counts().mediaPosts, 1, 'startup migration must be in flight');
  await page.evaluate(async () => {
    auditLog.unshift({ id: 'force-413-during-photo', action: 'Проверка' });
    await window.treshkaServerSync.flush();
  });
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(counts().mediaPosts, 1, '413 recovery must join the in-flight migration');
  await ctx.close();
});

test('v1.3 — quantity input accepts only whole numbers and rejects fractions, letters, negatives, zero and exponent notation', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => ({
    integer: parseQuantity('15'),
    zeroAllowed: parseQuantity('0', true),
    comma: parseQuantity('1,5'),
    dot: parseQuantity('2.75'),
    letters: parseQuantity('1abc'),
    negative: parseQuantity('-1'),
    zeroDenied: parseQuantity('0'),
    exponent: parseQuantity('1e3'),
    empty: parseQuantity(''),
  }));
  assert.equal(r.integer, 15, 'a whole positive quantity must be accepted');
  assert.equal(r.zeroAllowed, 0, 'zero is valid only in explicitly non-negative fields');
  assert.equal(r.comma, null, 'a fraction with a comma must be rejected, not truncated');
  assert.equal(r.dot, null, 'a fraction with a point must be rejected, not truncated');
  assert.equal(r.letters, null, 'letters mixed with a number must be rejected');
  assert.equal(r.negative, null, 'negative quantities must be rejected');
  assert.equal(r.zeroDenied, null, 'movement/write-off quantity must be strictly positive');
  assert.equal(r.exponent, null, 'scientific notation must not bypass the strict input format');
  assert.equal(r.empty, null, 'an empty value must be rejected');

  const movement = await page.evaluate(() => {
    currentRole = 'admin';
    const i = items.find((x) => x.stock >= 2);
    const post = posts[0].name;
    const stockBefore = i.stock;
    const postBefore = i.posts[post] || 0;
    openQuickTransfer(i.id, 'toPost', post);
    document.getElementById('qt_qty').value = '2';
    submitQuickTransfer(i.id, 'toPost');
    const afterInteger = { stock: i.stock, post: i.posts[post] || 0 };
    openQuickTransfer(i.id, 'toPost', post);
    document.getElementById('qt_qty').value = '0,5';
    submitQuickTransfer(i.id, 'toPost');
    return { stockBefore, postBefore, afterInteger, afterInvalid: { stock: i.stock, post: i.posts[post] || 0 } };
  });
  assert.equal(movement.afterInteger.stock, movement.stockBefore - 2, 'integer issue must decrement warehouse stock exactly');
  assert.equal(movement.afterInteger.post, movement.postBefore + 2, 'integer issue must increment post stock exactly');
  assert.deepEqual(movement.afterInvalid, movement.afterInteger, 'a fractional issue must not mutate stock');
  await ctx.close();
});

test('v1.3 — only an administrator can reassign a post responsible person', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => {
    const idx = 0;
    const before = posts[idx].curator;
    currentRole = 'kladovshik';
    openPost(idx);
    const buttonForStorekeeper = [...document.querySelectorAll('#content button')].some((b) => b.textContent.includes('Переназначить ответственного'));
    const storekeeperResult = updatePostResponsible(idx, 'НЕ ДОЛЖЕН СОХРАНИТЬСЯ');
    const afterStorekeeper = posts[idx].curator;
    currentRole = 'admin';
    openPost(idx);
    const buttonForAdmin = [...document.querySelectorAll('#content button')].some((b) => b.textContent.includes('Переназначить ответственного'));
    const adminResult = updatePostResponsible(idx, 'Новый ответственный');
    return { before, buttonForStorekeeper, storekeeperResult, afterStorekeeper, buttonForAdmin, adminResult, afterAdmin: posts[idx].curator };
  });
  assert.equal(r.buttonForStorekeeper, false, 'storekeeper must not see the reassignment control');
  assert.equal(r.storekeeperResult, false, 'direct function invocation must also be denied for a storekeeper');
  assert.equal(r.afterStorekeeper, r.before, 'denied reassignment must not alter stored data');
  assert.equal(r.buttonForAdmin, true, 'administrator must see the reassignment control');
  assert.equal(r.adminResult, true, 'administrator must be allowed to save a new responsible person');
  assert.equal(r.afterAdmin, 'Новый ответственный');
  await ctx.close();
});

test('review round — inventory completion creates and displays a persistent inventory act', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(async () => {
    currentRole = 'admin';
    views.inventory();
    startCycleCount();
    items.forEach((i) => setCount(i.id, String(i.stock)));
    const completed = await finishCycleCount();
    return {
      completed,
      cycleFinished: cycleCount === null,
      acts: inventoryActs.length,
      no: inventoryActs[0]?.no,
      rendered: document.getElementById('content').textContent.includes(inventoryActs[0]?.no || 'NO-ACT'),
      allLinesArchived: Object.values(inventoryActDetailCache)[0]?.lines?.length === items.length,
      summaryIsCompact: !Array.isArray(inventoryActs[0]?.lines),
    };
  });
  assert.equal(r.completed, true);
  assert.equal(r.cycleFinished, true);
  assert.equal(r.acts, 1);
  assert.match(r.no, /^ИНВ-/);
  assert.equal(r.rendered, true);
  assert.equal(r.allLinesArchived, true);
  assert.equal(r.summaryIsCompact, true);
  await ctx.close();
});

test('inventory — storekeeper draft persists, bulk fill preserves counted rows and QR warns before replacing a repeat', async () => {
  const { ctx, page, pageErrors } = await newPage();
  const beforeReload = await page.evaluate(() => {
    currentRole = 'kladovshik';
    const started = startCycleCount();
    const first = items[0];
    const firstValue = Number(first.stock) + 2;
    setCount(first.id, String(firstValue));
    requestConfirmRemaining();
    runInventoryConfirm();
    const firstAfterBulk = cycleCount.counts[first.id];
    const allFilled = cycleCount.itemIds.every((id) => cycleCount.counts[id] !== undefined);
    const otherDraft = deepClone(cycleCount);
    otherDraft.id = 'inventory-other-user';
    otherDraft.actor = { ...otherDraft.actor, id: 'other-user', login: 'other-user' };
    cycleCountServerDrafts['other-user'] = otherDraft;
    const serializedDrafts = serializeAppState().cycleCountDrafts;
    const serializedHasDraft = serializedDrafts?.[cycleCount.actor.id]?.id === cycleCount.id;
    const preservesOtherDraft = serializedDrafts?.['other-user']?.id === otherDraft.id;

    _pendingScanTarget = 'count';
    onNativeScanResult(`SKLAD-ITEM:${first.sku}`);
    const repeatWarning = document.getElementById('sheetLayer').textContent.includes('уже считалась');
    document.getElementById('inventoryScanQty').value = String(firstValue + 1);
    applyCountFromSheet(first.id);
    const confirmationShown = document.getElementById('sheetLayer').textContent.includes('Повторный пересчёт');
    runInventoryConfirm();
    return {
      started,
      id: cycleCount.id,
      firstAfterBulk,
      firstValue,
      allFilled,
      serializedHasDraft,
      preservesOtherDraft,
      repeatWarning,
      confirmationShown,
      replacedValue: cycleCount.counts[first.id],
      localDraft: JSON.parse(localStorage.getItem(CYCLE_COUNT_STORAGE_KEY) || 'null'),
    };
  });
  assert.equal(beforeReload.started, true);
  assert.equal(beforeReload.firstAfterBulk, beforeReload.firstValue, 'bulk confirmation must not overwrite an already counted row');
  assert.equal(beforeReload.allFilled, true);
  assert.equal(beforeReload.serializedHasDraft, true);
  assert.equal(beforeReload.preservesOtherDraft, true);
  assert.equal(beforeReload.repeatWarning, true);
  assert.equal(beforeReload.confirmationShown, true);
  assert.equal(beforeReload.replacedValue, beforeReload.firstValue + 1);
  assert.equal(beforeReload.localDraft.id, beforeReload.id);
  assert.equal(beforeReload.localDraft.counts[beforeReload.localDraft.itemIds[0]], beforeReload.firstValue + 1);

  await page.reload();
  await page.waitForTimeout(250);
  const afterReload = await page.evaluate(() => ({
    id: cycleCount?.id,
    needsResume: cycleCountNeedsResume,
    count: cycleCount?.counts?.[cycleCount.itemIds[0]],
  }));
  assert.equal(afterReload.id, beforeReload.id);
  assert.equal(afterReload.needsResume, true);
  assert.equal(afterReload.count, beforeReload.firstValue + 1);
  assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join('; ')}`);
  await ctx.close();
});

test('inventory — completed act exports two exact sheets and prints every warehouse line with actor and scope', async () => {
  const { ctx, page, pageErrors } = await newPage(() => {
    window.__savedFiles = [];
    window.__printCalls = [];
    window.AndroidFiles = {
      saveExportedFile: (base64, filename, mime) => {
        window.__savedFiles.push({ base64, filename, mime });
        return true;
      },
    };
    window.AndroidPrint = {
      printHtml: (html, job, format) => window.__printCalls.push({ html, job, format }),
    };
  });
  const result = await page.evaluate(async () => {
    currentRole = 'admin';
    const originalXlsxDownload = xlsxDownload;
    window.__inventorySheets = null;
    xlsxDownload = (filename, sheets) => {
      window.__inventorySheets = { filename, sheets: JSON.parse(JSON.stringify(sheets)) };
      return originalXlsxDownload(filename, sheets);
    };
    startCycleCount();
    items.forEach((entry, index) => setCount(entry.id, String(Number(entry.stock) + (index === 0 ? 1 : 0))));
    const completed = await finishCycleCount();
    const exported = await exportInventoryActExcel(0);
    const printed = await printInventoryAct(0);
    const detail = inventoryActDetailCache[inventoryActs[0].id];
    return {
      completed,
      exported,
      printed,
      sheets: window.__inventorySheets,
      files: window.__savedFiles.map(({ filename, mime }) => ({ filename, mime })),
      print: window.__printCalls[0],
      itemCount: items.length,
      lineCount: detail.lines.length,
      actor: detail.actor,
      summaryHasLines: Array.isArray(inventoryActs[0].lines),
      adjusted: items[0].stock === detail.lines[0].counted,
    };
  });
  assert.equal(result.completed, true);
  assert.equal(result.exported, true);
  assert.equal(result.printed, true);
  assert.equal(result.summaryHasLines, false, 'shared snapshot must retain only the compact act header');
  assert.equal(result.lineCount, result.itemCount);
  assert.equal(result.adjusted, true);
  assert.equal(result.actor.role, 'admin');
  assert.deepEqual(result.sheets.sheets.map((sheet) => sheet.name), ['Акт', 'Позиции']);
  assert.equal(result.sheets.sheets[1].rows.length, result.itemCount + 1);
  assert.match(result.files[0].filename, /^ИНВ-.*_inventarizatsiya\.xlsx$/);
  assert.equal(result.print.format, 'a4');
  assert.match(result.print.html, /только остатки основного склада/i);
  assert.match(result.print.html, /Проводил:/);
  assert.ok(result.print.html.includes(result.actor.name));
  assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join('; ')}`);
  await ctx.close();
});

test('review round — catalog generates collision-free SKUs, supports ABC, receipts/write-offs and safe CRUD', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => {
    currentRole = 'admin';
    const tempCategory = 'Тестовая категория CRUD';
    categoriesList.push(tempCategory); CAT_ICON[tempCategory] = '🧪';
    const catIndex = categoriesList.indexOf(tempCategory);
    openEditCategoryForm('top', catIndex);
    document.getElementById('ec_name').value = tempCategory + ' 2';
    document.getElementById('ec_icon').value = '🔬';
    const categoryEdited = submitEditCategory('top', catIndex);

    skladPath = [tempCategory + ' 2'];
    openAddItemForm();
    document.getElementById('ni_name').value = 'Товар CRUD 1';
    document.getElementById('ni_stock').value = '1,5';
    const beforeInvalid = items.length;
    submitNewItem();
    const fractionRejected = items.length === beforeInvalid;
    document.getElementById('ni_stock').value = '2';
    document.getElementById('ni_abc').value = 'A';
    submitNewItem();
    const first = items.find((i) => i.name === 'Товар CRUD 1');

    openEditItemForm(first.id);
    document.getElementById('ei_sku').value = 'НВ-9002';
    document.getElementById('ei_abc').value = 'B';
    submitEditItem(first.id);
    skladPath = [tempCategory + ' 2'];
    openAddItemForm();
    document.getElementById('ni_name').value = 'Товар CRUD 2';
    document.getElementById('ni_stock').value = '0';
    submitNewItem();
    const second = items.find((i) => i.name === 'Товар CRUD 2');

    openStockAdjustment(first.id, 'in');
    document.getElementById('adjustQty').value = '3'; document.getElementById('adjustReason').value = 'Накладная TEST';
    const receipt = applyStockAdjustment(first.id, 'in', null);
    openStockAdjustment(first.id, 'off');
    document.getElementById('adjustQty').value = '1'; document.getElementById('adjustReason').value = 'Списание TEST';
    const writeoff = applyStockAdjustment(first.id, 'off', null);

    const secondDeleted = deleteItem(second.id);
    const categoryDeleteBlockedWhileUsed = deleteCategory('top', categoriesList.indexOf(tempCategory + ' 2')) === false;
    first.stock = 0; first.ext = 0; first.posts = {};
    const firstDeleted = deleteItem(first.id);
    const categoryDeleted = deleteCategory('top', categoriesList.indexOf(tempCategory + ' 2'));
    return { categoryEdited, fractionRejected, firstAbc: first.abc, sku1: first.sku, sku2: second.sku, receipt, writeoff, stockAfterOps: 4, actualStock: first.stock, secondDeleted, categoryDeleteBlockedWhileUsed, firstDeleted, categoryDeleted };
  });
  assert.equal(r.categoryEdited, true);
  assert.equal(r.fractionRejected, true);
  assert.equal(r.firstAbc, 'B');
  assert.equal(r.sku1, 'НВ-9002');
  assert.notEqual(r.sku2, r.sku1, 'automatic SKU must scan existing values instead of reusing a manually assigned number');
  assert.equal(r.receipt, true);
  assert.equal(r.writeoff, true);
  assert.equal(r.secondDeleted, true);
  assert.equal(r.categoryDeleteBlockedWhileUsed, true);
  assert.equal(r.firstDeleted, true);
  assert.equal(r.categoryDeleted, true);
  await ctx.close();
});

test('catalog deletion is visible and executable only for an administrator', async () => {
  const { ctx, page } = await newPage();
  const result = await page.evaluate(() => {
    const template = items[0] ? JSON.parse(JSON.stringify(items[0])) : {};
    const candidate = {
      ...template,
      id: 'delete-role-test',
      name: 'Карточка для проверки удаления',
      sku: 'DELETE-ROLE-TEST',
      stock: 0,
      ext: 0,
      posts: {},
      lots: [],
      history: [],
      photo: '',
      photoMedia: null,
    };
    items.push(candidate);

    currentRole = 'kladovshik';
    openItem(candidate.id);
    const storekeeperSeesButton = document.getElementById('content').textContent.includes('Удалить карточку');
    const storekeeperDeleted = deleteItem(candidate.id);
    const existsAfterStorekeeper = items.some((value) => value.id === candidate.id);

    currentRole = 'admin';
    openItem(candidate.id);
    const adminSeesButton = document.getElementById('content').textContent.includes('Удалить карточку');
    const adminDeleted = deleteItem(candidate.id);
    return {
      storekeeperSeesButton,
      storekeeperDeleted,
      existsAfterStorekeeper,
      adminSeesButton,
      adminDeleted,
      existsAfterAdmin: items.some((value) => value.id === candidate.id),
    };
  });
  assert.equal(result.storekeeperSeesButton, false);
  assert.equal(result.storekeeperDeleted, false);
  assert.equal(result.existsAfterStorekeeper, true);
  assert.equal(result.adminSeesButton, true);
  assert.equal(result.adminDeleted, true);
  assert.equal(result.existsAfterAdmin, false);
  await ctx.close();
});

test('closed documents and returned external issues remain renderable after product deletion', async () => {
  const { ctx, page, pageErrors } = await newPage();
  const result = await page.evaluate(() => {
    currentRole = 'admin';
    const template = items[0] ? JSON.parse(JSON.stringify(items[0])) : {};
    const candidate = {
      ...template,
      id: 'delete-history-test',
      name: 'Архивный аттенюатор',
      sku: 'ARCHIVE-ATT-10',
      unit: 'шт',
      stock: 0,
      ext: 0,
      posts: {},
      lots: [],
      history: [],
      photo: '',
      photoMedia: null,
    };
    items.push(candidate);
    const workTemplate = docs.find((entry) => entry.kind === 'work');
    const work = {
      ...JSON.parse(JSON.stringify(workTemplate)),
      no: 'АВР-ARCHIVE-1',
      status: 'Закрыт',
      materials: [{ id: candidate.id, q: 2 }],
    };
    docs.push(work);
    extIssues.push({
      no: 'ВН-ARCHIVE-1',
      to: 'Тест',
      date: todayStr(),
      status: 'Возвращено',
      due: '—',
      note: '',
      items: [{ id: candidate.id, q: 1 }],
    });
    const deleted = deleteItem(candidate.id);
    views.ext();
    const externalText = document.getElementById('content').textContent;
    renderWorkDoc(work);
    const workText = document.getElementById('content').textContent;
    const printHtml = buildDefektPrintHtml(work, work.no);
    const workPrintHtml = buildWorkActPrintHtml(work, work.no);
    const workDocXml = buildWorkActDocumentXml(work);
    return {
      deleted,
      externalText,
      workText,
      printHtml,
      workPrintHtml,
      workDocXml,
      archivedDoc: work.materials[0],
      archivedIssue: extIssues.find((entry) => entry.no === 'ВН-ARCHIVE-1').items[0],
    };
  });
  assert.equal(result.deleted, true);
  assert.equal(pageErrors.length, 0, pageErrors.join('; '));
  assert.match(result.externalText, /Архивный аттенюатор/);
  assert.match(result.workText, /Архивный аттенюатор/);
  assert.match(result.printHtml, /Архивный аттенюатор/);
  assert.match(result.workPrintHtml, /Архивный аттенюатор/);
  assert.match(result.workPrintHtml, /ARCHIVE-ATT-10/);
  assert.match(result.workPrintHtml, /2 шт/);
  assert.match(result.workDocXml, /Архивный аттенюатор/);
  assert.match(result.workDocXml, /ARCHIVE-ATT-10/);
  assert.match(result.workDocXml, /2 шт/);
  assert.equal(result.archivedDoc.sku, 'ARCHIVE-ATT-10');
  assert.equal(result.archivedIssue.unit, 'шт');
  await ctx.close();
});

test('server conflict resolution lets every role accept server truth but keeps local replay privileged', async () => {
  const { ctx, page } = await newPage(() => {
    window.confirm = () => true;
    window.__resolvedConflict = null;
    window.AndroidFiles = {
      saveExportedFile: () => { throw new Error('automatic public export must not run'); },
    };
    window.AndroidSync = {
      status: () => JSON.stringify({
        configured: true,
        serverRevision: 4,
        pending: 1,
        conflicts: 1,
        conflictBackups: 1,
        serverRole: 'worker',
      }),
      listConflicts: () => '[]',
      resolveConflict: (...args) => {
        window.__resolvedConflict = args;
        return JSON.stringify({ ok: true, backupSaved: true });
      },
    };
  });
  const result = await page.evaluate(() => {
    currentRole = 'rabotnik';
    const localDenied = resolveServerConflict(42, 'local');
    const ok = resolveServerConflict(42, 'server');
    return {
      ok,
      localDenied,
      resolved: window.__resolvedConflict,
    };
  });
  assert.equal(result.ok, true);
  assert.equal(result.localDenied, false);
  assert.deepEqual(result.resolved, [42, 'server']);
  await ctx.close();
});

test('conflict backup export is admin-only and delegates streaming to the native bridge', async () => {
  const { ctx, page } = await newPage(() => {
    window.__backupExports = 0;
    window.__nativeRole = 'worker';
    window.AndroidSync = {
      status: () => JSON.stringify({
        configured: true,
        serverRevision: 4,
        pending: 0,
        conflictBackups: 1,
        serverRole: window.__nativeRole,
      }),
      exportLatestConflictBackup: () => {
        window.__backupExports += 1;
        return JSON.stringify({ ok: true, filename: 'treshka_conflict_test.json' });
      },
    };
  });
  const result = await page.evaluate(() => {
    const worker = exportLatestConflictBackup();
    window.__nativeRole = 'owner';
    const admin = exportLatestConflictBackup();
    return { worker, admin, exports: window.__backupExports };
  });
  assert.deepEqual(result, { worker: false, admin: true, exports: 1 });
  await ctx.close();
});

test('server UI never falls back to a client admin role while server identity is missing', async () => {
  const { ctx, page } = await newPage(() => {
    window.treshkaServerRole = () => '';
  });
  const result = await page.evaluate(() => {
    currentRole = 'admin';
    const missingSession = canAdminister();
    window.treshkaServerRole = () => 'owner';
    const owner = canAdminister();
    window.treshkaServerRole = () => 'worker';
    const worker = canAdminister();
    return { missingSession, owner, worker };
  });
  assert.deepEqual(result, { missingSession: false, owner: true, worker: false });
  await ctx.close();
});

test('server settings explain an unknown migrated native role instead of hiding conflicts silently', async () => {
  const { ctx, page } = await newPage(() => {
    window.treshkaServerRole = () => 'owner';
    window.AndroidSync = {
      status: () => JSON.stringify({
        configured: true,
        serverRevision: 9,
        pending: 1,
        conflictBackups: 0,
        serverRole: '',
        serverRoleUnknown: true,
      }),
      listConflicts: () => JSON.stringify({
        error: 'Требуется повторный вход для подтверждения роли',
      }),
    };
  });
  const text = await page.evaluate(() => {
    renderServerSettings();
    return document.getElementById('content').textContent;
  });
  assert.match(text, /Не удалось подтвердить роль этого аккаунта/);
  assert.match(text, /Требуется повторный вход для подтверждения роли/);
  await ctx.close();
});

test('review round — post movements are listed and an over-limit return is rejected atomically', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => {
    currentRole = 'admin';
    const i = items.find((x) => Object.values(x.posts).some((q) => q > 0));
    const post = Object.keys(i.posts).find((p) => i.posts[p] > 0);
    const have = i.posts[post];
    const stockBefore = i.stock;
    issueDest = post; issueSelected = { [i.id]: have + 1 };
    commitIssue('sklad');
    const rejected = i.posts[post] === have && i.stock === stockBefore && stockTransfers.length === 0;
    issueSelected = { [i.id]: 1 };
    commitIssue('sklad');
    views.ext();
    return { rejected, returned: i.posts[post] === have - 1 && i.stock === stockBefore + 1, transferCount: stockTransfers.length, visible: document.getElementById('content').textContent.includes('Возвращено на склад') };
  });
  assert.equal(r.rejected, true);
  assert.equal(r.returned, true);
  assert.equal(r.transferCount, 1);
  assert.equal(r.visible, true);
  await ctx.close();
});

test('review round — administrator can edit and safely delete an unused post', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => {
    currentRole = 'admin';
    posts.push({ name: 'Пост CRUD', full: 'Временный', curator: 'Старый', stock: [], repairs: [] });
    const idx = posts.length - 1;
    openEditPostForm(idx);
    document.getElementById('ep_name').value = 'Пост CRUD 2';
    document.getElementById('ep_full').value = 'Обновлён';
    document.getElementById('ep_curator').value = 'Новый ответственный';
    const edited = submitEditPost(idx);
    const renamed = posts[idx].name === 'Пост CRUD 2' && posts[idx].curator === 'Новый ответственный';
    const deleted = deletePost(idx);
    return { edited, renamed, deleted, gone: !posts.some((p) => p.name === 'Пост CRUD 2') };
  });
  assert.deepEqual(r, { edited: true, renamed: true, deleted: true, gone: true });
  await ctx.close();
});

test('review round — defect validation allows no serial, links/creates a card, moves it through repair and blocks non-repairable work', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => {
    currentRole = 'admin';
    views.newDefekt();
    const linked = items.find((i) => i.unit === 'шт');
    const post = posts[0].name;
    const linkedStockBefore = linked.stock;
    document.getElementById('f_order').value = 'З-ROUND-DEF';
    document.getElementById('f_itemid').value = linked.id; onDefektItemChange();
    document.getElementById('f_serial').value = '';
    document.getElementById('f_date').value = '32.07.2026';
    document.getElementById('f_from').value = 'Внешнее подразделение';
    document.getElementById('f_post').value = post;
    document.getElementById('f_callsign').value = 'Тест';
    document.getElementById('f_fault').value = 'Не включается';
    document.getElementById('f_defects').value = 'Неисправность';
    document.getElementById('f_verdict').value = 'Ремонтопригодно';
    checkDefekt();
    const badDateRejected = document.getElementById('defSubmit').disabled;
    document.getElementById('f_date').value = '22.07.2026'; checkDefekt();
    const noSerialAccepted = !document.getElementById('defSubmit').disabled;
    submitDefekt();
    const defect = docs.find((d) => d.orderNo === 'З-ROUND-DEF');
    const enteredRepair = linked.posts[post] > 0 && posts[0].stock.some((s) => s.id === linked.id && s.q > 0);
    createWorkFromDefekt(defect.no);
    const work = docs.find((d) => d.defektDoc === defect.no);
    work.actionTypes = ['Ремонт']; work.works = [{ type: 'Ремонт', qty: 1 }]; work.participants = [{ worker: 'Мастер', work: 'Ремонт' }]; work.otkPassed = true;
    closeWork(work.no);
    currentRole = 'admin';
    approveWork(work.no);
    currentRole = 'kladovshik';
    acceptWorkToWarehouse(work.no);
    const returnedToWarehouse = linked.stock === linkedStockBefore + 1 && !linked.posts[post];

    views.newDefekt();
    document.getElementById('f_order').value = 'З-CREATE-CARD';
    document.getElementById('f_item_name').value = 'Новое изделие из дефектовки';
    document.getElementById('f_create_card').checked = true;
    document.getElementById('f_create_wrap').style.display = 'block';
    document.getElementById('f_date').value = '22.07.2026';
    document.getElementById('f_from').value = 'Внешнее подразделение';
    document.getElementById('f_post').value = post;
    document.getElementById('f_callsign').value = 'Тест';
    document.getElementById('f_fault').value = 'Не включается';
    document.getElementById('f_defects').value = 'Неисправность';
    document.getElementById('f_verdict').value = 'Ремонтопригодно';
    submitDefekt();
    const createdDefect = docs.find((d) => d.orderNo === 'З-CREATE-CARD');
    const cardCreatedFromDefect = !!createdDefect?.itemId && item(createdDefect.itemId)?.name === 'Новое изделие из дефектовки';

    const bad = { ...JSON.parse(JSON.stringify(defect)), no: 'ДФ-BAD-ROUND', orderNo: 'BAD', verdict: 'Не подлежит ремонту (списание)', workDoc: null };
    docs.push(bad); const workCount = docs.filter((d) => d.kind === 'work').length; createWorkFromDefekt(bad.no);
    return { badDateRejected, noSerialAccepted, serial: defect.serial, linkedId: defect.itemId, enteredRepair, returnedToWarehouse, cardCreatedFromDefect, badWorkBlocked: docs.filter((d) => d.kind === 'work').length === workCount };
  });
  assert.equal(r.badDateRejected, true);
  assert.equal(r.noSerialAccepted, true);
  assert.equal(r.serial, '—');
  assert.ok(r.linkedId);
  assert.equal(r.enteredRepair, true);
  assert.equal(r.returnedToWarehouse, true);
  assert.equal(r.cardCreatedFromDefect, true);
  assert.equal(r.badWorkBlocked, true);
  await ctx.close();
});

test('review round — external issue validates date/stock and work-act rework becomes editable but cannot bypass mismatch approval', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => {
    currentRole = 'admin';
    views.issueExt();
    const i = items.find((x) => x.stock > 0);
    document.getElementById('ei_to').value = 'Получатель TEST';
    document.getElementById('ei_item').value = i.id;
    document.getElementById('ei_qty').value = String(i.stock + 1);
    document.getElementById('ei_due').value = 'да';
    const stockBefore = i.stock, extBefore = extIssues.length;
    submitExtIssue();
    const invalidRejected = i.stock === stockBefore && extIssues.length === extBefore;

    const base = docs.find((d) => d.kind === 'work' && d.planQty != null);
    const d = JSON.parse(JSON.stringify(base)); d.no = 'АВР-REWORK-ROUND'; d.status = 'Расхождение'; d.planQty = 10; d.factQty = 8; d.mismatchDecision = null;
    d.actionTypes = ['Ремонт']; d.works = [{ type: 'Ремонт', qty: 1 }]; d.participants = [{ worker: 'Мастер', work: 'Ремонт' }]; d.otkPassed = true; d.materials = [];
    docs.push(d); renderWorkDoc(d);
    const participantEditorPresent = !!document.getElementById('participantName') && !!document.getElementById('participantWork');
    const materialOptionsOnlyFromPost = [...document.querySelectorAll('#addSel option')].every((o) => (item(o.value)?.posts[d.post] || 0) > 0);
    document.getElementById('mm_reason').value = 'Нужна повторная проверка'; document.getElementById('mm_decision').value = 'rework'; resolveMismatch(d.no);
    const reopened = d.status === 'На доработке' && !hasUnresolvedMismatch(d);
    currentRole = 'rabotnik'; closeWork(d.no);
    return { invalidRejected, participantEditorPresent, materialOptionsOnlyFromPost, reopened, resubmitted: d.status === 'Расхождение' && d.status !== 'Закрыт' };
  });
  assert.equal(r.invalidRejected, true);
  assert.equal(r.participantEditorPresent, true);
  assert.equal(r.materialOptionsOnlyFromPost, true);
  assert.equal(r.reopened, true);
  assert.equal(r.resubmitted, true);
  await ctx.close();
});

test('v1.3 — stock issue is atomic and rolls back every changed collection when recording fails', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => {
    currentRole = 'admin';
    const product = items.find((x) => x.stock >= 2);
    const post = posts[0].name;
    const before = { stock: product.stock, post: product.posts[post] || 0, transfers: stockTransfers.length, audit: auditLog.length, notifications: notifications.length };
    const original = recordStockTransfer;
    recordStockTransfer = () => { throw new Error('simulated persistence failure'); };
    const ok = runStockTransaction('test', () => {
      transferToPost(product, post, 1);
      recordStockTransfer('toPost', post, [{ id: product.id, q: 1 }]);
    });
    recordStockTransfer = original;
    const restored = item(product.id);
    return { ok, before, after: { stock: restored.stock, post: restored.posts[post] || 0, transfers: stockTransfers.length, audit: auditLog.length, notifications: notifications.length } };
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.after, r.before);
  await ctx.close();
});

test('review c3db85a — rejected native remote save restores the pre-callback JavaScript state', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => {
    const first = items[0];
    const before = {
      stock: first.stock,
      docs: docs.length,
      transfers: stockTransfers.length,
    };
    const incoming = JSON.parse(JSON.stringify(serializeAppState()));
    incoming.items[0].stock = before.stock + 999;
    incoming.docs = [];
    incoming.stockTransfers = [];
    let reported = '';
    window.AndroidStorage = {
      saveRemoteState: () => false,
      reportRemoteStateRejected: (reason) => { reported = reason; },
    };
    const ok = window.onNativeRemoteState(JSON.stringify(incoming), 999);
    return {
      ok,
      reported,
      before,
      after: {
        stock: items[0].stock,
        docs: docs.length,
        transfers: stockTransfers.length,
      },
    };
  });
  assert.equal(r.ok, false);
  assert.match(r.reported, /локальные данные восстановлены/);
  assert.deepEqual(r.after, r.before, 'a stale native callback must not leave WebView memory ahead of SQLite');
  await ctx.close();
});

test('review c3db85a — privileged workflow guards reject direct calls and work-close rollback restores its document', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(async () => {
    const source = JSON.parse(JSON.stringify(docs.find((entry) => entry.kind === 'work')));
    const valid = {
      ...source,
      no: 'АВР-GUARD-VALID',
      status: 'Ожидает приёмки на склад',
      itemId: null,
      materials: [],
    };
    docs.push(valid);

    currentRole = 'admin';
    const deniedClose = performWorkClose(valid) === false
      && docs.find((entry) => entry.no === valid.no)?.status === 'Ожидает приёмки на склад';

    // Prove the fixture itself is valid. If the role guard is removed, the
    // preceding admin call will close it and this assertion will fail.
    currentRole = 'kladovshik';
    const validClose = performWorkClose(valid) === true
      && docs.find((entry) => entry.no === valid.no)?.status === 'Закрыт';

    const broken = {
      ...source,
      no: 'АВР-GUARD-ROLLBACK',
      status: 'Ожидает приёмки на склад',
      itemId: null,
      materials: [{ id: '__missing_item__', q: 1 }],
    };
    docs.push(broken);
    currentRole = 'kladovshik';
    const failedClose = performWorkClose(broken) === false;
    const documentRolledBack = docs.find((entry) => entry.no === broken.no)?.status === 'Ожидает приёмки на склад';

    currentRole = 'rabotnik';
    views.newDefekt();
    const cardCount = items.length;
    const docCount = docs.length;
    document.getElementById('f_order').value = 'З-GUARD-CARD';
    document.getElementById('f_item_name').value = 'Запрещённая карточка';
    document.getElementById('f_create_card').checked = true;
    document.getElementById('f_date').value = '26.07.2026';
    document.getElementById('f_from').value = 'Тест';
    document.getElementById('f_post').value = currentUserPost;
    document.getElementById('f_callsign').value = 'Тест';
    document.getElementById('f_fault').value = 'Тест';
    document.getElementById('f_defects').value = 'Тест';
    document.getElementById('f_verdict').value = 'Ремонтопригодно';
    const deniedCard = submitDefekt() === false && items.length === cardCount && docs.length === docCount;

    const actsBefore = inventoryActs.length;
    cycleCount = null;
    const deniedInventoryStart = startCycleCount() === false && cycleCount === null;
    cycleCount = { counts: {} };
    const deniedCount = setCount(items[0].id, '1') === false
      && Object.keys(cycleCount.counts).length === 0;
    const deniedInventoryFinish = await finishCycleCount() === false && inventoryActs.length === actsBefore;
    cycleCount = null;

    return {
      deniedClose,
      validClose,
      failedClose,
      documentRolledBack,
      deniedCard,
      deniedInventoryStart,
      deniedCount,
      deniedInventoryFinish,
    };
  });
  for (const [name, value] of Object.entries(r)) assert.equal(value, true, `${name} must be enforced`);
  await ctx.close();
});

test('v1.3 — admin creates a hashed worker account bound to a post and post notifications target that account', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(async () => {
    currentRole = 'admin';
    render({ fn: renderAccounts });
    document.getElementById('accountLogin').value = 'worker.tech';
    document.getElementById('accountPassword').value = 'secure-21208';
    document.getElementById('accountRole').value = 'rabotnik';
    document.getElementById('accountRole').dispatchEvent(new Event('change'));
    document.getElementById('accountPost').value = posts[0].name;
    const created = await createAccount();
    const a = accounts.find((x) => x.login === 'worker.tech');
    notifyPostUsers(posts[0].name, 'Поступление товара на пост', 'Тестовая поставка', 'stock', 'TEST');
    return {
      created,
      noPlaintext: a && !('password' in a) && a.passwordHash !== 'secure-21208',
      role: a?.role,
      post: a?.post,
      targeted: notifications.some((n) => n.recipientAccountId === a?.id && n.entityNo === 'TEST'),
    };
  });
  assert.equal(r.created, true);
  assert.equal(r.noPlaintext, true);
  assert.equal(r.role, 'rabotnik');
  assert.ok(r.post);
  assert.equal(r.targeted, true);
  await ctx.close();
});

test('v1.6 — every work act waits for admin approval and then storekeeper warehouse acceptance', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => {
    const base = docs.find((d) => d.kind === 'defekt' && d.status === 'Закрыт' && !String(d.verdict || '').includes('Не подлежит'));
    const source = { ...JSON.parse(JSON.stringify(base)), no: 'ДФ-APPROVAL-TEST', workDoc: null };
    docs.push(source);
    createWorkFromDefekt(source.no);
    const work = docs.find((d) => d.defektDoc === source.no);
    work.actionTypes = ['Ремонт'];
    work.works = [{ type: 'Ремонт', qty: 1 }];
    work.participants = [{ worker: 'Мастер', work: 'Ремонт' }];
    work.otkPassed = true;
    closeWork(work.no);
    const pending = work.status === 'Ожидает согласования';
    renderWorkDoc(work);
    const appHasAnalytics = document.getElementById('content').textContent.includes('Аналитика: выдано на пост / фактический расход');
    const print = buildWorkActPrintHtml(work, actFileTitle(work));
    currentRole = 'admin';
    approveWork(work.no);
    const awaitingWarehouse = work.status === 'Ожидает приёмки на склад';
    currentRole = 'kladovshik';
    acceptWorkToWarehouse(work.no);
    return { pending, awaitingWarehouse, closed: work.status === 'Закрыт', appHasAnalytics, printHasAnalytics: print.includes('Аналитика: выдано') };
  });
  assert.equal(r.pending, true);
  assert.equal(r.awaitingWarehouse, true);
  assert.equal(r.closed, true);
  assert.equal(r.appHasAnalytics, true);
  assert.equal(r.printHasAnalytics, false);
  await ctx.close();
});

test('v1.4 — a compatible remote snapshot is migrated and atomically persisted without creating a sync loop', async () => {
  const { ctx, page } = await newPage(() => {
    window.__remoteSaves = [];
    window.AndroidStorage = {
      loadState: () => 'null',
      loadBackupState: () => 'null',
      saveState: () => true,
      saveRemoteState: (json, schema, revision) => {
        window.__remoteSaves.push({ json, schema, revision });
        return true;
      },
    };
  });
  const result = await page.evaluate(() => {
    const remote = serializeAppState();
    remote.items[0].stock += 7;
    const expected = remote.items[0].stock;
    const ok = window.onNativeRemoteState(JSON.stringify(remote), 77);
    return {
      ok,
      stock: items[0].stock,
      expected,
      saves: window.__remoteSaves.map((x) => ({ schema: x.schema, revision: x.revision })),
      lastPayloadMatches: _lastSavedPayload === window.__remoteSaves[0]?.json,
    };
  });
  assert.equal(result.ok, true);
  assert.equal(result.stock, result.expected);
  assert.deepEqual(result.saves, [{ schema: 4, revision: 77 }]);
  assert.equal(result.lastPayloadMatches, true);
  await ctx.close();
});

test('v1.4 — a newer incompatible server schema never overwrites the local database', async () => {
  const { ctx, page } = await newPage(() => {
    window.__remoteSaves = 0;
    window.AndroidStorage = {
      loadState: () => 'null',
      loadBackupState: () => 'null',
      saveState: () => true,
      saveRemoteState: () => { window.__remoteSaves += 1; return true; },
    };
  });
  const result = await page.evaluate(() => {
    const before = JSON.stringify(serializeAppState());
    const incompatible = JSON.parse(before);
    incompatible.schemaVersion = APP_SCHEMA_VERSION + 1;
    incompatible.items[0].stock = 999999;
    const ok = window.onNativeRemoteState(JSON.stringify(incompatible), 88);
    return {
      ok,
      unchanged: JSON.stringify(serializeAppState()) === before,
      remoteSaves: window.__remoteSaves,
      error: _nativeSyncStatus.lastError,
    };
  });
  assert.equal(result.ok, false);
  assert.equal(result.unchanged, true);
  assert.equal(result.remoteSaves, 0);
  assert.match(result.error, /несовместимую схему/);
  await ctx.close();
});

test('v1.6 — a new server database starts without products while keeping posts and a compact snapshot', async () => {
  const { ctx, page } = await newPage();
  const result = await page.evaluate(() => {
    items.length = 0;
    posts.forEach((post) => { post.stock = []; });
    stockTransfers.length = 0;
    inventoryActs.length = 0;
    const state = serializeAppState();
    state.accounts = [];
    state.currentAccountId = null;
    return {
      itemCount: state.items.length,
      postCount: state.posts.length,
      postNames: state.posts.map((post) => post.name),
      payloadBytes: new TextEncoder().encode(JSON.stringify(state)).byteLength,
    };
  });
  assert.equal(result.itemCount, 0);
  assert.ok(result.postCount >= 11, `all prescribed posts must remain, got ${result.postCount}`);
  assert.ok(result.postNames.includes('ТЭЧ'));
  assert.ok(result.postNames.includes('Намотки оптоволокна'));
  assert.ok(result.payloadBytes < 500_000, `empty-catalog snapshot is unexpectedly large: ${result.payloadBytes} bytes`);
  await ctx.close();
});

test('v1.6 — server foundation keeps one bounded shared snapshot and durable Android outbox', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sync = readFileSync(path.join(root, 'android', 'app', 'src', 'main', 'java', 'com', 'treshka', 'sklad', 'AppStateStore.kt'), 'utf8');
  const api = readFileSync(path.join(root, 'app', 'api', 'state', 'route.ts'), 'utf8');
  const browserSync = readFileSync(path.join(root, 'public', 'prototype-server.js'), 'utf8');
  assert.match(sync, /sync_outbox/);
  assert.match(sync, /db\.beginTransaction\(\)/);
  assert.match(api, /warehouse_full_state/);
  assert.match(api, /MAX_STATE_BYTES/);
  assert.match(api, /expectedRevision/);
  assert.match(api, /WHERE state_key = 'main' AND revision = \?/);
  assert.match(api, /status: 409/);
  assert.doesNotMatch(api, /DROP\s+TABLE/i);
  assert.match(browserSync, /uploadIfChanged/);
  assert.match(browserSync, /state\.accounts = \[\]/);
  assert.match(browserSync, /expectedRevision: sync\.revision/);
  assert.match(browserSync, /treshka-sync-conflict/);
  assert.match(browserSync, /function canUploadState\(\)/);
  assert.match(browserSync, /if \(!canUploadState\(\)\)/);
  assert.match(sync, /fun claimNextPending\(\)/);
  assert.match(sync, /conflict INTEGER NOT NULL DEFAULT 0/);
  assert.match(browserSync, /items\.length = 0/);
});

test('v1.6 — every initially rendered control is wired to an existing function and navigation target', async () => {
  const { ctx, page, pageErrors } = await newPage();
  const result = await page.evaluate(() => {
    const ids = Array.from(document.querySelectorAll('[id]'), (element) => element.id);
    const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
    const missingFunctions = [];
    const missingPages = [];
    const checkedHandlers = [];

    for (const element of document.querySelectorAll('[onclick], [onchange], [oninput]')) {
      for (const attribute of ['onclick', 'onchange', 'oninput']) {
        const source = element.getAttribute(attribute);
        if (!source) continue;
        const functionMatch = source.trim().match(/^([A-Za-z_$][\w$]*)\s*\(/);
        if (functionMatch) {
          checkedHandlers.push(functionMatch[1]);
          if (typeof window[functionMatch[1]] !== 'function') {
            missingFunctions.push(`${attribute}:${functionMatch[1]}`);
          }
        }
        for (const match of source.matchAll(/\bgo\(['"]([^'"]+)['"]/g)) {
          if (typeof views[match[1]] !== 'function') missingPages.push(match[1]);
        }
      }
    }

    return {
      duplicateIds: [...new Set(duplicateIds)],
      missingFunctions: [...new Set(missingFunctions)],
      missingPages: [...new Set(missingPages)],
      checkedHandlers: [...new Set(checkedHandlers)].length,
    };
  });
  assert.deepEqual(result.duplicateIds, [], `duplicate DOM ids: ${result.duplicateIds.join(', ')}`);
  assert.deepEqual(result.missingFunctions, [], `missing event functions: ${result.missingFunctions.join(', ')}`);
  assert.deepEqual(result.missingPages, [], `missing navigation pages: ${result.missingPages.join(', ')}`);
  assert.ok(result.checkedHandlers >= 5, `expected the five main navigation controls, got ${result.checkedHandlers}`);
  assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join('; ')}`);
  await ctx.close();
});

test('security — user text cannot break out of headers or product edit fields, and unsafe photo URLs are rejected', async () => {
  const { ctx, page, pageErrors } = await newPage();
  const result = await page.evaluate(() => {
    currentRole = 'admin';
    const target = items[0];
    target.name = '<img id="xss-header" src=x onerror="window.__xss=1">';
    target.desc = '</textarea><img id="xss-description" src=x onerror="window.__xss=2">';
    target.photo = 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+';
    openEditItemForm(target.id);
    const editEscaped = !document.getElementById('xss-description')
      && document.getElementById('ei_desc').value.includes('</textarea>');
    openItem(target.id);
    return {
      editEscaped,
      headerEscaped: !document.getElementById('xss-header') && document.getElementById('hdrTitle').textContent.includes('<img'),
      unsafePhotoHidden: !document.querySelector('.photo-box img'),
      executed: window.__xss || 0,
    };
  });
  assert.equal(result.editEscaped, true);
  assert.equal(result.headerEscaped, true);
  assert.equal(result.unsafePhotoHidden, true);
  assert.equal(result.executed, 0);
  assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join('; ')}`);
  await ctx.close();
});

test('server revision history is visible to admins and restorable only by the owner', async () => {
  const owner = await newHttpServerPage({ role: 'owner' });
  const ownerMore = await owner.page.evaluate(() => {
    render({ fn: views.more });
    return document.getElementById('content').textContent;
  });
  assert.match(ownerMore, /История ревизий/);

  await owner.page.evaluate(() => renderStateHistory());
  await owner.page.waitForFunction(() => document.getElementById('content').textContent.includes('Ревизия 6'));
  await owner.page.evaluate(() => renderStateRevision(6));
  await owner.page.waitForFunction(() => document.getElementById('content').textContent.includes('Восстановить ревизию 6'));
  assert.equal(await owner.page.isDisabled('#restoreRevisionButton'), true);
  await owner.page.fill('#restoreRevisionCode', '6');
  assert.equal(await owner.page.isEnabled('#restoreRevisionButton'), true);
  owner.page.once('dialog', (dialog) => dialog.accept());
  assert.equal(await owner.page.evaluate(() => restoreStateRevision(6)), true);
  assert.equal(owner.counts().historyRestores, 1);
  assert.ok(owner.counts().historyGets >= 3, 'list, preview and refreshed list must all reach the server');
  assert.ok(owner.counts().stateGets >= 2, 'restore must force-fetch the canonical restored state');
  await owner.ctx.close();

  const admin = await newHttpServerPage({ role: 'admin' });
  await admin.page.evaluate(() => renderStateRevision(6));
  await admin.page.waitForFunction(() => document.getElementById('content').textContent.includes('Администратор может просматривать историю'));
  assert.equal(
    await admin.page.evaluate(() => document.getElementById('content').textContent.includes('Восстановить ревизию 6')),
    false,
  );
  await admin.ctx.close();

  const staleOwner = await newHttpServerPage({ role: 'owner', historyRestoreStatus: 409 });
  await staleOwner.page.evaluate(() => renderStateRevision(6));
  await staleOwner.page.fill('#restoreRevisionCode', '6');
  staleOwner.page.once('dialog', (dialog) => dialog.accept());
  assert.equal(await staleOwner.page.evaluate(() => restoreStateRevision(6)), false);
  assert.equal(await staleOwner.page.evaluate(() => window.treshkaServerSync.status().revision), 8);
  assert.ok(staleOwner.counts().stateGets >= 2, 'a stale restore must force-refresh current server state');
  await staleOwner.ctx.close();
});
