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

const PROTOTYPE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'prototype.html',
);
const PROTOTYPE_URL = 'file://' + PROTOTYPE_PATH;

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
    hasRolePin: typeof requestRoleSwitch === 'function' && typeof ROLE_PINS === 'object',
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

test('#5/#6 — privileged roles require a PIN; rabotnik cannot export the whole warehouse', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => {
    const out = {};
    currentRole = 'admin';
    requestRoleSwitch('rabotnik');
    out.rabotnikNoPinNeeded = currentRole === 'rabotnik';

    currentRole = 'rabotnik';
    requestRoleSwitch('admin');
    out.pinSheetShown = document.getElementById('rolePinInput') !== null;
    document.getElementById('rolePinInput').value = 'WRONG';
    confirmRoleSwitch('admin');
    out.wrongPinRejected = currentRole === 'rabotnik';
    document.getElementById('rolePinInput').value = ROLE_PINS.admin;
    confirmRoleSwitch('admin');
    out.correctPinAccepted = currentRole === 'admin';

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

test('regression — QR encodes the immutable item id and survives a SKU rename', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => {
    const i = items.find((x) => x.id === 'flux');
    const before = genQR(i.id);
    const oldSku = i.sku;
    i.sku = 'РМ-9999-NEW';
    const after = genQR(i.id);
    const encodesId = qrValue(i).includes(i.id) && !qrValue(i).includes(oldSku);
    i.sku = oldSku;
    return { sameImage: before === after, encodesId };
  });
  assert.equal(r.sameImage, true);
  assert.equal(r.encodesId, true);
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
  assert.equal(r.version, '1.1');
  assert.ok(r.html.includes('версия 1.1'), 'more() screen must render the current app version');
  await ctx.close();
});

test('regression — app version is also shown in the persistent top masthead on every screen', async () => {
  const { ctx, page } = await newPage();
  const text = await page.evaluate(() => document.getElementById('mastVersion').textContent);
  assert.equal(text, 'v1.1');
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
    await page.evaluate((s) => go(s), screen);
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
      saveExportedFile: (base64, filename, mime) => { window.__savedFiles.push(filename); return true; },
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

test('regression — schema migration v1→v2 backfills work-act fields and upgrades legacy string works to {type,qty}', async () => {
  const { ctx, page } = await newPage();
  const r = await page.evaluate(() => {
    const base = JSON.parse(JSON.stringify(serializeAppState()));
    const legacy = JSON.parse(JSON.stringify(base));
    legacy.schemaVersion = 1;
    legacy.docs = legacy.docs.map((d) => {
      if (d.kind !== 'work') return d;
      const { actionTypes, resultText, otkPassed, ...rest } = d;
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
  assert.equal(r.schemaVersion, 2);
  assert.equal(r.hasActionTypes, true, 'migration must backfill actionTypes:[] where missing');
  assert.equal(r.resultTextIsString, true, 'migration must backfill resultText:\'\' where missing');
  assert.equal(r.otkPassedIsBool, true, 'migration must backfill otkPassed:false where missing');
  assert.equal(r.firstWorkIsObject, true, 'migration must convert legacy string work entries to {type, qty:1} objects');
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
  assert.ok(docXml.includes('АКТ ВЫПОЛНЕННЫХ РАБОТ №145'), 'document.xml must contain the act title with its number');
  assert.ok(docXml.includes('«17» июля 2026 г.'), 'document.xml must contain the long-form Russian date');
  assert.ok(docXml.includes('Ремонт'), 'document.xml must contain the selected action type');
  assert.ok(docXml.includes('отремонтировано'), 'document.xml must contain the auto-derived result status');
  assert.ok(docXml.includes('Герасимчук'), 'document.xml must contain the fixed "Передал" signer');
  assert.ok(docXml.includes('ОТК пройдено ответственный командир отделения ремонтного поста'), 'document.xml must contain the fixed blank OTK signature line');
  assert.ok(docXml.includes('Флюс паяльный ТТ'), 'document.xml must list the act\'s materials table (from d.materials)');
  await ctx.close();
});

test('regression — the updated PDF/print form for a work act matches the new template (not the old bare materials-only layout)', async () => {
  const { ctx, page } = await newPage(() => {
    window.__printCalls = [];
    window.AndroidPrint = { printHtml: (html, job) => { window.__printCalls.push({ job, html }); } };
  });
  const r = await page.evaluate(() => { printDoc('АВР-145'); return window.__printCalls[0]; });
  assert.equal(r.job, 'Акт выполненных работ №145 от 17.07.2026 ремонт');
  assert.ok(r.html.includes('АКТ ВЫПОЛНЕННЫХ РАБОТ №145'), 'print form must show the new title with act number');
  assert.ok(r.html.includes('«17» июля 2026 г.'), 'print form must show the long-form Russian date');
  assert.ok(r.html.includes('Вид действия: Ремонт'), 'print form must show the selected action type(s)');
  assert.ok(r.html.includes('Наименование работ'), 'print form must include the "Наименование работ" table');
  assert.ok(r.html.includes('Сборочные работы'), 'print form must list the act\'s works (from d.works)');
  assert.ok(r.html.includes('отремонтировано'), 'print form must show the auto-derived result status');
  assert.ok(r.html.includes('ОТК пройдено ответственный командир отделения ремонтного поста'), 'print form must include the fixed blank OTK signature line');
  assert.ok(r.html.includes('Герасимчук'), 'print form must include the fixed "Передал" signer');
  await ctx.close();
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
