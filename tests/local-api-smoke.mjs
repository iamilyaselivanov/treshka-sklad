import assert from "node:assert/strict";

const baseUrl = process.env.E2E_BASE_URL ?? "http://localhost:4316";
const allowRemote = process.env.ALLOW_REMOTE_E2E === "1";
const parsedBase = new URL(baseUrl);
if (!allowRemote && !["localhost", "127.0.0.1", "::1"].includes(parsedBase.hostname)) {
  throw new Error("Remote API smoke tests require ALLOW_REMOTE_E2E=1");
}

const owner = {
  callsign: process.env.E2E_OWNER_CALLSIGN ?? "Тест-владелец",
  login: process.env.E2E_OWNER_LOGIN ?? "owner-local",
  password: process.env.E2E_OWNER_PASSWORD ?? "OwnerPass-1600",
  setupCode: process.env.E2E_SETUP_CODE ?? "LOCAL-SETUP-1.6",
};

async function request(path, init = {}, expected = 200) {
  const startedAt = performance.now();
  const response = await fetch(new URL(path, baseUrl), init);
  const elapsedMs = Math.round(performance.now() - startedAt);
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { error: raw };
  }
  const expectedStatuses = Array.isArray(expected) ? expected : [expected];
  assert.ok(
    expectedStatuses.includes(response.status),
    `${init.method ?? "GET"} ${path}: expected ${expectedStatuses.join("/")} got ${response.status}: ${JSON.stringify(data)}`,
  );
  return { response, data, elapsedMs };
}

async function authenticateOwner() {
  const status = await request("/api/auth/status");
  const result = status.data.setupRequired
    ? await request("/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(owner),
      }, 201)
    : await request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login: owner.login, password: owner.password }),
      });
  const setCookie = result.response.headers.get("set-cookie");
  assert.ok(setCookie, "Authentication response did not set a session cookie");
  return {
    cookie: setCookie.split(";")[0],
    user: result.data.user,
    elapsedMs: result.elapsedMs,
  };
}

const suffix = Date.now().toString(36);
const createdIds = [];
const roleCookies = {};
const pushDevices = [];
const timings = {};
let disabledDeliveryTerminalVerified = false;
const auth = await authenticateOwner();
const ownerHeaders = { cookie: auth.cookie };
roleCookies.owner = auth.cookie;
timings.ownerAuthentication = auth.elapsedMs;

try {
  const definitions = [
    { callsign: "Тест-админ", login: `admin-${suffix}`, password: "AdminPass-1600", role: "admin", assignment: "" },
    { callsign: "Тест-кладовщик", login: `store-${suffix}`, password: "StorePass-1600", role: "storekeeper", assignment: "" },
    { callsign: "Тест-работник", login: `worker-${suffix}`, password: "WorkerPass-1600", role: "worker", assignment: "  тЭч  " },
  ];

  for (const definition of definitions) {
    const created = await request("/api/users", {
      method: "POST",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify(definition),
    }, 201);
    createdIds.push(created.data.user.id);
    timings[`create_${definition.role}`] = created.elapsedMs;

    const login = await request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: definition.login, password: definition.password }),
    });
    assert.equal(login.data.user.callsign, definition.callsign);
    roleCookies[definition.role] = login.response.headers.get("set-cookie").split(";")[0];
    timings[`login_${definition.role}`] = login.elapsedMs;
  }
  await request("/api/users", {
    method: "POST",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      callsign: "Работник без поста",
      login: `worker-unassigned-${suffix}`,
      password: "WorkerPass-1600",
      role: "worker",
      assignment: "   ",
    }),
  }, 400);

  const fifthAttemptTarget = definitions.find((definition) => definition.role === "admin");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: fifthAttemptTarget.login, password: "Definitely-Wrong-1600" }),
    }, 401);
  }
  const fifthAttemptSuccess = await request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login: fifthAttemptTarget.login, password: fifthAttemptTarget.password }),
  });
  assert.equal(fifthAttemptSuccess.data.user.login, fifthAttemptTarget.login);

  const bruteTarget = definitions.find((definition) => definition.role === "worker");
  const parallelFailures = await Promise.all(Array.from({ length: 5 }, () =>
    fetch(new URL("/api/auth/login", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: bruteTarget.login, password: "Definitely-Wrong-1600" }),
    })));
  const parallelFailureStatuses = parallelFailures.map((response) => response.status);
  assert.ok(parallelFailureStatuses.every((status) => status === 401 || status === 429));
  assert.ok(
    parallelFailureStatuses.includes(429),
    `the atomic failure threshold must close the concurrent race: ${parallelFailureStatuses.join(",")}`,
  );
  await request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login: bruteTarget.login, password: bruteTarget.password }),
  }, 429);
  const throttleAudit = await request("/api/audit", { headers: ownerHeaders });
  assert.equal(
    throttleAudit.data.entries.filter((entry) => entry.action === "login_blocked").length,
    1,
    "only the threshold crossing should create a security audit row",
  );
  assert.equal(
    throttleAudit.data.entries.some((entry) => entry.action === "login_failed"),
    false,
    "individual unauthenticated failures must not evict the real audit history",
  );

  const users = await request("/api/users", { headers: ownerHeaders });
  assert.equal(users.data.users.filter((user) => createdIds.includes(user.id)).length, 3);

  await request(`/api/users?id=${encodeURIComponent(auth.user.id)}`, {
    method: "DELETE",
    headers: ownerHeaders,
  }, 403);
  await request("/api/users", { headers: { cookie: roleCookies.worker } }, 403);

  for (const role of ["owner", "admin", "storekeeper", "worker"]) {
    const deviceId = crypto.randomUUID();
    const token = `${role}-${suffix}-`.padEnd(96, "x");
    pushDevices.push({ role, deviceId });
    const registered = await request("/api/devices/register", {
      method: "POST",
      headers: { cookie: roleCookies[role], "content-type": "application/json" },
      body: JSON.stringify({ deviceId, token, platform: "android", appVersion: "1.6" }),
    });
    assert.equal(registered.data.ok, true);
  }

  const pushCases = [
    { actor: "owner", type: "post_stock_issued", targets: 1 },
    { actor: "storekeeper", type: "post_stock_returned", targets: 2 },
    { actor: "worker", type: "defect_act_created", targets: 3 },
    { actor: "worker", type: "work_act_created", targets: 3 },
    { actor: "admin", type: "work_awaiting_warehouse", targets: 2 },
    { actor: "storekeeper", type: "storekeeper_post_issue_completed", targets: 2 },
    { actor: "storekeeper", type: "storekeeper_warehouse_return_accepted", targets: 2 },
  ];
  for (const pushCase of pushCases) {
    const payload = {
      eventId: crypto.randomUUID(),
      type: pushCase.type,
      post: "ТЭЧ",
      entityNo: `TEST-${pushCase.type}`,
      summary: "Проверка маршрутизации push",
    };
    const event = await request("/api/notifications/events", {
      method: "POST",
      headers: { cookie: roleCookies[pushCase.actor], "content-type": "application/json" },
      body: JSON.stringify(payload),
    }, [200, 503]);
    assert.equal(event.data.targetDevices, pushCase.targets, `${pushCase.type} recipient routing`);
    if (!event.data.pushConfigured) {
      assert.equal(event.response.status, 200, `${pushCase.type} disabled Firebase is terminal`);
      assert.equal(
        Number(event.data.disabled ?? 0),
        pushCase.targets,
        `${pushCase.type} disabled deliveries are counted once`,
      );
      assert.equal(Number(event.data.terminal ?? 0), pushCase.targets);
      disabledDeliveryTerminalVerified = true;
    } else if (event.response.status === 503) {
      assert.equal(Number(event.data.failed ?? 0), pushCase.targets);
    }
    if (pushCase.type === "defect_act_created" && event.response.status === 503) {
      const retry = await request("/api/notifications/events", {
        method: "POST",
        headers: { cookie: roleCookies[pushCase.actor], "content-type": "application/json" },
        body: JSON.stringify(payload),
      }, 503);
      assert.equal(retry.data.targetDevices, pushCase.targets);
      assert.equal(
        Number(retry.data.failed ?? 0) + Number(retry.data.disabled ?? 0),
        pushCase.targets,
      );
    }
  }
  await request("/api/notifications/events", {
    method: "POST",
    headers: { cookie: roleCookies.worker, "content-type": "application/json" },
    body: JSON.stringify({
      eventId: crypto.randomUUID(),
      type: "storekeeper_post_issue_completed",
      post: "ТЭЧ",
      entityNo: "FORBIDDEN",
    }),
  }, 403);

  for (let index = 0; index < 7; index += 1) {
    const deviceId = crypto.randomUUID();
    pushDevices.push({ role: "owner", deviceId });
    await request("/api/devices/register", {
      method: "POST",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        deviceId,
        token: `owner-extra-${index}-${suffix}`.padEnd(96, "x"),
        platform: "android",
        appVersion: "1.6",
      }),
    });
  }
  const overflowDeviceId = crypto.randomUUID();
  pushDevices.push({ role: "owner", deviceId: overflowDeviceId });
  const overflowRegistration = await request("/api/devices/register", {
    method: "POST",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      deviceId: overflowDeviceId,
      token: `owner-over-limit-${suffix}`.padEnd(96, "x"),
      platform: "android",
      appVersion: "1.6",
    }),
  });
  assert.equal(overflowRegistration.data.evictedOldest, true);

  const product = await request("/api/products", {
    method: "POST",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      name: "Проверка удаления карточки",
      sku: `DELETE-${suffix}`,
      category: "Тест",
      quantity: 0,
      unit: "шт",
      location: "",
      minimum: 0,
    }),
  }, 201);
  await request(`/api/products?id=${encodeURIComponent(product.data.product.id)}`, {
    method: "DELETE",
    headers: { cookie: roleCookies.storekeeper },
  }, 403);
  await request(`/api/products?id=${encodeURIComponent(product.data.product.id)}`, {
    method: "DELETE",
    headers: { cookie: roleCookies.admin },
  });
  const usedProduct = await request("/api/products", {
    method: "POST",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      name: "Проверка запрета удаления остатка",
      sku: `USED-${suffix}`,
      category: "Тест",
      quantity: 1,
      unit: "шт",
      location: "",
      minimum: 0,
    }),
  }, 201);
  await request(`/api/products?id=${encodeURIComponent(usedProduct.data.product.id)}`, {
    method: "DELETE",
    headers: { cookie: roleCookies.admin },
  }, 409);

  const state = await request("/api/state", { headers: ownerHeaders });
  assert.equal(state.data.user.id, auth.user.id);
  assert.ok(Number.isInteger(state.data.revision));
  assert.equal(state.data.partial, false);
  timings.stateBootstrap = state.elapsedMs;

  const sharedState = state.data.state ?? {
    schemaVersion: 4,
    items: [{
      id: `inventory-probe-${suffix}`,
      name: "Позиция серверной инвентаризации",
      sku: `INV-PROBE-${suffix}`,
      unit: "шт",
      stock: 3,
      ext: 0,
      posts: {},
      lots: [],
      history: [],
    }],
    posts: [{ id: "post-test", name: "ТЭЧ", stock: [], repairs: [] }],
    docs: [],
    extIssues: [],
    stockTransfers: [],
    inventoryActs: [],
    auditLog: [],
  };
  const inventoryBootstrap = await request("/api/state", {
    method: "PUT",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({ state: sharedState, expectedRevision: state.data.revision }),
  });
  const inventoryId = `inventory-${crypto.randomUUID()}`;
  const inventoryStartedAt = new Date(Date.now() - 60_000).toISOString();
  const inventoryFinishedAt = new Date().toISOString();
  const inventoryLines = sharedState.items.map((item, index) => ({
    id: item.id,
    name: item.name,
    sku: item.sku,
    unit: item.unit,
    book: Number(item.stock),
    counted: Number(item.stock) + (index === 0 ? 1 : 0),
  }));
  await request("/api/inventory/acts", {
    method: "POST",
    headers: { cookie: roleCookies.worker, "content-type": "application/json" },
    body: JSON.stringify({
      id: inventoryId,
      startedAt: inventoryStartedAt,
      finishedAt: inventoryFinishedAt,
      lines: inventoryLines,
    }),
  }, 403);
  const inventoryArchived = await request("/api/inventory/acts", {
    method: "POST",
    headers: { cookie: roleCookies.storekeeper, "content-type": "application/json" },
    body: JSON.stringify({
      id: inventoryId,
      startedAt: inventoryStartedAt,
      finishedAt: inventoryFinishedAt,
      lines: inventoryLines,
      actor: { id: "forged", role: "owner", name: "Подмена" },
    }),
  }, 201);
  assert.match(inventoryArchived.data.act.no, /^ИНВ-\d{6}$/);
  assert.equal(inventoryArchived.data.act.actor.role, "storekeeper");
  assert.equal(inventoryArchived.data.act.actor.id, createdIds[1]);
  assert.equal(inventoryArchived.data.act.lines.length, sharedState.items.length);
  const inventoryRetry = await request("/api/inventory/acts", {
    method: "POST",
    headers: { cookie: roleCookies.storekeeper, "content-type": "application/json" },
    body: JSON.stringify({
      id: inventoryId,
      startedAt: inventoryStartedAt,
      finishedAt: inventoryFinishedAt,
      lines: inventoryLines,
    }),
  });
  assert.equal(inventoryRetry.data.idempotent, true);
  assert.equal(inventoryRetry.data.act.no, inventoryArchived.data.act.no);
  await request("/api/inventory/acts", {
    method: "POST",
    headers: { cookie: roleCookies.admin, "content-type": "application/json" },
    body: JSON.stringify({
      id: inventoryId,
      startedAt: inventoryStartedAt,
      finishedAt: inventoryFinishedAt,
      lines: inventoryLines,
    }),
  }, 409);
  const inventoryFetched = await request(`/api/inventory/acts?id=${encodeURIComponent(inventoryId)}`, {
    headers: ownerHeaders,
  });
  assert.equal(inventoryFetched.data.act.id, inventoryId);
  const pendingBeforeCommit = await request("/api/inventory/acts", { headers: ownerHeaders });
  assert.equal(pendingBeforeCommit.data.pending.length, 1);
  assert.equal(pendingBeforeCommit.data.pending[0].id, inventoryId);
  const inventoryHeader = { ...inventoryArchived.data.act };
  delete inventoryHeader.lines;
  const inventoryCommittedState = {
    ...sharedState,
    items: sharedState.items.map((item, index) => ({
      ...item,
      stock: inventoryLines[index].counted,
    })),
    inventoryActs: [inventoryHeader],
  };
  const forgedInventoryCommit = await request("/api/state", {
    method: "PUT",
    headers: { cookie: roleCookies.storekeeper, "content-type": "application/json" },
    body: JSON.stringify({
      state: {
        ...inventoryCommittedState,
        inventoryActs: [{
          ...inventoryHeader,
          totals: { ...inventoryHeader.totals, mismatched: 999 },
        }],
      },
      expectedRevision: inventoryBootstrap.data.revision,
    }),
  }, 409);
  assert.match(forgedInventoryCommit.data.error, /защищённому серверному архиву/);
  const inventoryCommitted = await request("/api/state", {
    method: "PUT",
    headers: { cookie: roleCookies.storekeeper, "content-type": "application/json" },
    body: JSON.stringify({
      state: inventoryCommittedState,
      expectedRevision: inventoryBootstrap.data.revision,
    }),
  });
  Object.assign(sharedState, inventoryCommittedState);
  state.data.revision = inventoryCommitted.data.revision;
  state.data.state = sharedState;
  const pendingAfterCommit = await request("/api/inventory/acts", { headers: ownerHeaders });
  assert.deepEqual(pendingAfterCommit.data.pending, []);
  const foreignPendingId = `inventory-owner-${crypto.randomUUID()}`;
  const ownerPending = await request("/api/inventory/acts", {
    method: "POST",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      id: foreignPendingId,
      startedAt: inventoryStartedAt,
      finishedAt: new Date().toISOString(),
      lines: inventoryCommittedState.items.map((item) => ({
        id: item.id,
        name: item.name,
        sku: item.sku,
        unit: item.unit,
        book: Number(item.stock),
        counted: Number(item.stock),
      })),
    }),
  }, 201);
  assert.equal(ownerPending.data.act.actor.id, auth.user.id);
  const pendingHiddenFromOtherStorekeeper = await request("/api/inventory/acts", {
    headers: { cookie: roleCookies.storekeeper },
  });
  assert.deepEqual(pendingHiddenFromOtherStorekeeper.data.pending, []);
  const pendingVisibleToManager = await request("/api/inventory/acts", { headers: ownerHeaders });
  assert.equal(pendingVisibleToManager.data.pending[0].id, foreignPendingId);
  for (const [field, replacement] of [
    ["no", "ИНВ-ПОДМЕНА"],
    ["actor", { ...inventoryHeader.actor, name: "Подменённый автор" }],
    ["totals", { ...inventoryHeader.totals, mismatched: 999 }],
  ]) {
    const forgedHeader = { ...inventoryHeader, [field]: replacement };
    const forgedExistingInventoryAct = await request("/api/state", {
      method: "PUT",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        state: { ...inventoryCommittedState, inventoryActs: [forgedHeader] },
        expectedRevision: inventoryCommitted.data.revision,
      }),
    }, 403);
    assert.match(
      forgedExistingInventoryAct.data.error,
      /сформированные акты инвентаризации/,
      `owner must not rewrite signed inventory header field ${field}`,
    );
  }
  const ownerInventoryWipe = await request("/api/state", {
    method: "PUT",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      state: { ...inventoryCommittedState, inventoryActs: [] },
      expectedRevision: inventoryCommitted.data.revision,
    }),
  }, 403);
  assert.match(ownerInventoryWipe.data.error, /сформированные акты инвентаризации/);
  const draftFor = (userId, role) => ({
    id: `draft-${userId}`,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    positions: inventoryCommittedState.items.length,
    itemIds: inventoryCommittedState.items.map((item) => item.id),
    books: Object.fromEntries(inventoryCommittedState.items.map((item) => [item.id, Number(item.stock)])),
    counts: {},
    actor: { id: userId, login: userId, role },
  });
  const ownerDraft = draftFor(auth.user.id, "owner");
  const ownerDraftSaved = await request("/api/state", {
    method: "PUT",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      state: {
        ...inventoryCommittedState,
        cycleCountDrafts: { [auth.user.id]: ownerDraft },
      },
      expectedRevision: inventoryCommitted.data.revision,
    }),
  });
  const storekeeperBeforeDraft = await request("/api/state", {
    headers: { cookie: roleCookies.storekeeper },
  });
  assert.deepEqual(storekeeperBeforeDraft.data.state.cycleCountDrafts, {});
  const storekeeperDraft = draftFor(createdIds[1], "storekeeper");
  const storekeeperDraftSaved = await request("/api/state", {
    method: "PUT",
    headers: { cookie: roleCookies.storekeeper, "content-type": "application/json" },
    body: JSON.stringify({
      state: {
        ...storekeeperBeforeDraft.data.state,
        cycleCountDrafts: { [createdIds[1]]: storekeeperDraft },
      },
      expectedRevision: ownerDraftSaved.data.revision,
    }),
  });
  const ownerDraftView = await request("/api/state", { headers: ownerHeaders });
  assert.deepEqual(Object.keys(ownerDraftView.data.state.cycleCountDrafts), [auth.user.id]);
  assert.equal(ownerDraftView.data.state.cycleCountDrafts[auth.user.id].id, ownerDraft.id);
  const storekeeperDraftView = await request("/api/state", {
    headers: { cookie: roleCookies.storekeeper },
  });
  assert.deepEqual(Object.keys(storekeeperDraftView.data.state.cycleCountDrafts), [createdIds[1]]);
  assert.equal(storekeeperDraftView.data.state.cycleCountDrafts[createdIds[1]].id, storekeeperDraft.id);
  const adminDraftView = await request("/api/state", { headers: { cookie: roleCookies.admin } });
  assert.deepEqual(adminDraftView.data.state.cycleCountDrafts, {});
  state.data.revision = storekeeperDraftSaved.data.revision;
  sharedState.accounts = [{ id: "must-not-be-stored", role: "owner" }];
  sharedState.currentAccountId = "must-not-be-stored";
  sharedState.currentRole = "admin";
  sharedState.savedAt = "must-not-create-a-new-revision";
  sharedState.auditLog = Array.from({ length: 2_000 }, (_, index) => ({ marker: index }));
  sharedState.notifications = Array.from({ length: 2_000 }, (_, index) => ({ id: `notification-${index}` }));
  sharedState.inventoryActs = [
    inventoryHeader,
    ...Array.from({ length: 4_999 }, (_, index) => ({ no: `inventory-${index}`, diffs: [] })),
  ];
  const rejectedLargeState = { ...sharedState, rejectedPadding: "x".repeat(128 * 1024) };
  await request("/api/state", {
    method: "PUT",
    headers: {
      ...ownerHeaders,
      "content-type": "application/json",
      origin: "https://untrusted.example",
      "sec-fetch-site": "cross-site",
    },
    body: JSON.stringify({ state: rejectedLargeState, expectedRevision: state.data.revision }),
  }, 403);
  const oversizedState = { ...sharedState, rejectedPadding: "x".repeat(1_510_000) };
  const oversizedWrite = await request("/api/state", {
    method: "PUT",
    // Workerd closes a connection after an early oversized-body response.
    // Isolate this probe so its dead keep-alive socket cannot poison the next assertion.
    headers: { ...ownerHeaders, "content-type": "application/json", connection: "close" },
    body: JSON.stringify({ state: oversizedState, expectedRevision: state.data.revision }),
  }, 413);
  assert.match(oversizedWrite.data.error, /1,5 МБ/);
  await request("/api/auth/status");
  const chunkedPayload = JSON.stringify({
    state: { ...sharedState, rejectedPadding: "y".repeat(1_510_000) },
    expectedRevision: state.data.revision,
  });
  const chunkedBytes = new TextEncoder().encode(chunkedPayload);
  const chunkedBody = new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < chunkedBytes.length; offset += 64 * 1024) {
        controller.enqueue(chunkedBytes.slice(offset, offset + 64 * 1024));
      }
      controller.close();
    },
  });
  const chunkedOversizedWrite = await request("/api/state", {
    method: "PUT",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: chunkedBody,
    duplex: "half",
  }, 413);
  assert.match(chunkedOversizedWrite.data.error, /1,5 МБ/);
  await request("/api/auth/status");
  const collectionOverflow = {
    ...sharedState,
    inventoryActs: [...sharedState.inventoryActs, { no: "inventory-overflow", diffs: [] }],
  };
  const rejectedCollectionOverflow = await request("/api/state", {
    method: "PUT",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({ state: collectionOverflow, expectedRevision: state.data.revision }),
  }, 413);
  assert.match(rejectedCollectionOverflow.data.error, /не были усечены/);
  const rejectedPartialSnapshot = await request("/api/state", {
    method: "PUT",
    headers: { cookie: roleCookies.admin, "content-type": "application/json" },
    body: JSON.stringify({
      state: sharedState,
      expectedRevision: state.data.revision,
      partial: true,
    }),
  }, 409);
  assert.equal(rejectedPartialSnapshot.data.recover, "server");
  await request("/api/state", {
    method: "PUT",
    headers: { cookie: roleCookies.worker, "content-type": "application/json" },
    body: JSON.stringify({ state: rejectedLargeState, expectedRevision: state.data.revision }),
  }, 403);
  const saved = await request("/api/state", {
    method: "PUT",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({ state: sharedState, expectedRevision: state.data.revision }),
  });
  assert.equal(saved.data.revision, state.data.revision + 1);
  const noOpSaved = await request("/api/state", {
    method: "PUT",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      state: { ...sharedState, savedAt: "a-different-volatile-timestamp" },
      expectedRevision: saved.data.revision,
    }),
  });
  assert.equal(noOpSaved.data.unchanged, true);
  assert.equal(noOpSaved.data.revision, saved.data.revision);
  const stateAudit = await request("/api/audit", { headers: ownerHeaders });
  assert.ok(
    stateAudit.data.entries.some((entry) =>
      ["state_created", "state_updated"].includes(entry.action)
      && entry.details.includes(`ревизия ${saved.data.revision}`)),
    "Every successful state write must be present in the audit log",
  );

  const staleWrite = await request("/api/state", {
    method: "PUT",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({ state: sharedState, expectedRevision: state.data.revision }),
  }, 409);
  assert.equal(staleWrite.data.conflict, true);
  assert.equal(staleWrite.data.currentRevision, saved.data.revision);

  const sanitized = await request("/api/state", { headers: ownerHeaders });
  assert.equal("accounts" in sanitized.data.state, false);
  assert.equal("currentAccountId" in sanitized.data.state, false);
  assert.equal("currentRole" in sanitized.data.state, false);
  assert.equal("savedAt" in sanitized.data.state, false);
  assert.equal(sanitized.data.state.auditLog.length, 2_000);
  assert.equal(sanitized.data.state.notifications.length, 2_000);
  assert.equal(sanitized.data.state.inventoryActs.length, 5_000);
  const etag = sanitized.response.headers.get("etag");
  assert.match(etag, new RegExp(`^W/"warehouse-main-${sanitized.data.revision}-`));
  const notModified = await fetch(new URL("/api/state", baseUrl), {
    headers: { ...ownerHeaders, "if-none-match": etag },
  });
  assert.equal(notModified.status, 304);
  assert.equal(await notModified.text(), "");
  const adminSnapshot = await request("/api/state", { headers: { cookie: roleCookies.admin } });
  const adminEtag = adminSnapshot.response.headers.get("etag");
  assert.notEqual(adminEtag, etag, "ETag must include the authenticated authorization scope");
  const wrongAuthorizationScope = await fetch(new URL("/api/state", baseUrl), {
    headers: { cookie: roleCookies.admin, "if-none-match": etag },
  });
  assert.equal(wrongAuthorizationScope.status, 200, "a role/account change must never reuse another identity's 304");
  const workerSnapshot = await request("/api/state", { headers: { cookie: roleCookies.worker } });
  assert.equal(workerSnapshot.data.partial, true);
  assert.ok(workerSnapshot.data.state.posts.every((post) => post.name === "ТЭЧ"));
  assert.deepEqual(workerSnapshot.data.state.inventoryActs, []);
  assert.deepEqual(workerSnapshot.data.state.auditLog, []);
  assert.ok(workerSnapshot.data.state.items.every((item) =>
    Number(item.stock) === 0
    && Object.keys(item.posts ?? {}).every((post) => post === "ТЭЧ")));
  const deletionProbeId = `delete-state-${suffix}`;
  const stateWithDeletionProbe = {
    ...sanitized.data.state,
    items: [
      ...(sanitized.data.state.items ?? []),
      { id: deletionProbeId, name: "Проверка роли удаления", sku: `STATE-${suffix}`, stock: 1, ext: 0, posts: {}, lots: [] },
    ],
  };
  const deletionProbeSaved = await request("/api/state", {
    method: "PUT",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({ state: stateWithDeletionProbe, expectedRevision: sanitized.data.revision }),
  });
  const stateWithoutDeletionProbe = {
    ...stateWithDeletionProbe,
    items: stateWithDeletionProbe.items.filter((item) => item.id !== deletionProbeId),
  };
  const forbiddenDeletion = await request("/api/state", {
    method: "PUT",
    headers: { cookie: roleCookies.storekeeper, "content-type": "application/json" },
    body: JSON.stringify({ state: stateWithoutDeletionProbe, expectedRevision: deletionProbeSaved.data.revision }),
  }, 403);
  assert.equal(forbiddenDeletion.data.terminal, true);
  const usedDeletion = await request("/api/state", {
    method: "PUT",
    headers: { cookie: roleCookies.admin, "content-type": "application/json" },
    body: JSON.stringify({ state: stateWithoutDeletionProbe, expectedRevision: deletionProbeSaved.data.revision }),
  }, 409);
  assert.equal(usedDeletion.data.terminal, true);
  const originalDocs = stateWithDeletionProbe.docs ?? [];
  const stateWithDocumentReference = {
    ...stateWithDeletionProbe,
    items: stateWithDeletionProbe.items.map((item) =>
      item.id === deletionProbeId ? { ...item, stock: 0 } : item),
    docs: [...originalDocs, { no: `DOC-${suffix}`, kind: "work", status: "Черновик", itemId: deletionProbeId, materials: [] }],
  };
  const documentReferenceSaved = await request("/api/state", {
    method: "PUT",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      state: stateWithDocumentReference,
      expectedRevision: deletionProbeSaved.data.revision,
    }),
  });
  const forbiddenHistoryErase = await request("/api/state", {
    method: "PUT",
    headers: { cookie: roleCookies.storekeeper, "content-type": "application/json" },
    body: JSON.stringify({
      state: { ...stateWithDocumentReference, docs: [] },
      expectedRevision: documentReferenceSaved.data.revision,
    }),
  }, 403);
  assert.match(forbiddenHistoryErase.data.error, /историю складских операций/);
  const withoutDocumentReferencedItem = {
    ...stateWithDocumentReference,
    items: stateWithDocumentReference.items.filter((item) => item.id !== deletionProbeId),
  };
  await request("/api/state", {
    method: "PUT",
    headers: { cookie: roleCookies.admin, "content-type": "application/json" },
    body: JSON.stringify({
      state: withoutDocumentReferencedItem,
      expectedRevision: documentReferenceSaved.data.revision,
    }),
  }, 409);
  const safeStateWithProbe = {
    ...stateWithDocumentReference,
    docs: [...originalDocs, { no: `DOC-CLOSED-${suffix}`, kind: "work", status: "Закрыт", itemId: deletionProbeId }],
    extIssues: [
      ...(stateWithDocumentReference.extIssues ?? []),
      {
        no: `EXT-CLOSED-${suffix}`,
        status: "Возвращено",
        items: [{
          id: deletionProbeId,
          q: 1,
          name: "Проверка роли удаления",
          sku: `STATE-${suffix}`,
          unit: "шт",
        }],
      },
    ],
  };
  const safeProbeSaved = await request("/api/state", {
    method: "PUT",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      state: safeStateWithProbe,
      expectedRevision: documentReferenceSaved.data.revision,
    }),
  });
  const safeStateWithoutProbe = {
    ...safeStateWithProbe,
    items: safeStateWithProbe.items.filter((item) => item.id !== deletionProbeId),
  };
  const adminDeletion = await request("/api/state", {
    method: "PUT",
    headers: { cookie: roleCookies.admin, "content-type": "application/json" },
    body: JSON.stringify({
      state: safeStateWithoutProbe,
      expectedRevision: safeProbeSaved.data.revision,
    }),
  });
  let stateAfterDeletion = await request("/api/state", { headers: ownerHeaders });
  assert.equal(stateAfterDeletion.data.revision, adminDeletion.data.revision);
  assert.equal(stateAfterDeletion.data.state.items.some((item) => item.id === deletionProbeId), false);
  const linkedProduct = await request("/api/products", {
    method: "POST",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      name: "Карточка общего снимка",
      sku: `LINKED-${suffix}`,
      category: "Тест",
      quantity: 0,
      unit: "шт",
      location: "",
      minimum: 0,
    }),
  }, 201);
  const linkedState = {
    ...stateAfterDeletion.data.state,
    items: [
      ...(stateAfterDeletion.data.state.items ?? []),
      {
        id: linkedProduct.data.product.id,
        name: linkedProduct.data.product.name,
        sku: linkedProduct.data.product.sku,
        stock: 0,
        ext: 0,
        posts: {},
        lots: [],
      },
    ],
    stockTransfers: [
      ...(stateAfterDeletion.data.state.stockTransfers ?? []),
      { no: `MOVE-${suffix}`, type: "toPost", post: "ТЭЧ", items: [{ id: linkedProduct.data.product.id, q: 1 }] },
    ],
    inventoryActs: [
      { no: `INV-${suffix}`, diffs: [{ id: linkedProduct.data.product.id, counted: 0 }] },
      ...(stateAfterDeletion.data.state.inventoryActs ?? []).slice(0, 4_999),
    ],
  };
  const linkedSaved = await request("/api/state", {
    method: "PUT",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({ state: linkedState, expectedRevision: stateAfterDeletion.data.revision }),
  });
  const linkedDeleted = await request(`/api/products?id=${encodeURIComponent(linkedProduct.data.product.id)}`, {
    method: "DELETE",
    headers: { cookie: roleCookies.admin },
  });
  assert.equal(linkedDeleted.data.revision, linkedSaved.data.revision + 1);
  const productsAfterLinkedDeletion = await request("/api/products", { headers: ownerHeaders });
  assert.equal(
    productsAfterLinkedDeletion.data.products.some((entry) => entry.id === linkedProduct.data.product.id),
    false,
  );
  stateAfterDeletion = await request("/api/state", { headers: ownerHeaders });
  assert.equal(
    stateAfterDeletion.data.state.items.some((item) => item.id === linkedProduct.data.product.id),
    false,
  );
  const archivedTransferLine = stateAfterDeletion.data.state.stockTransfers
    .find((entry) => entry.no === `MOVE-${suffix}`).items[0];
  assert.equal(archivedTransferLine.name, linkedProduct.data.product.name);
  assert.equal(archivedTransferLine.sku, linkedProduct.data.product.sku);
  const archivedInventoryLine = stateAfterDeletion.data.state.inventoryActs
    .find((entry) => entry.no === `INV-${suffix}`).diffs[0];
  assert.equal(archivedInventoryLine.name, linkedProduct.data.product.name);
  const firstNotification = stateAfterDeletion.data.state.notifications[0];
  const markedReadState = {
    ...stateAfterDeletion.data.state,
    notifications: stateAfterDeletion.data.state.notifications.map((entry, index) =>
      index === 0 ? { ...entry, read: true } : entry),
  };
  const markedRead = await request("/api/state", {
    method: "PUT",
    headers: { cookie: roleCookies.storekeeper, "content-type": "application/json" },
    body: JSON.stringify({
      state: markedReadState,
      expectedRevision: stateAfterDeletion.data.revision,
    }),
  });
  assert.equal(markedRead.data.revision, stateAfterDeletion.data.revision + 1);
  await request("/api/state", {
    method: "PUT",
    headers: { cookie: roleCookies.admin, "content-type": "application/json" },
    body: JSON.stringify({
      state: {
        ...markedReadState,
        notifications: markedReadState.notifications.map((entry, index) =>
          index === 0 ? { ...entry, text: `${String(firstNotification.text ?? "")}-tampered` } : entry),
      },
      expectedRevision: markedRead.data.revision,
    }),
  }, 403);
  const overflowState = {
    ...markedReadState,
    auditLog: [
      ...Array.from({ length: 201 }, (_, index) => ({ marker: `overflow-${index}` })),
      ...(markedReadState.auditLog ?? []).slice(0, 1_799),
    ],
  };
  await request("/api/state", {
    method: "PUT",
    headers: { cookie: roleCookies.admin, "content-type": "application/json" },
    body: JSON.stringify({
      state: overflowState,
      expectedRevision: markedRead.data.revision,
    }),
  }, 403);
  const overflowAudit = await request("/api/audit", { headers: ownerHeaders });
  assert.ok(
    overflowAudit.data.entries.some((entry) =>
      entry.action === "state_history_mutation_rejected"
      && entry.details.includes("Роль admin")
      && entry.details.includes("mutation")),
    "a forged history mutation must leave a dedicated audit record",
  );
  assert.ok(
    overflowAudit.data.entries.some((entry) =>
      entry.action === "state_feed_append_rejected"
      && entry.details.includes("Роль admin")
      && entry.details.includes("журнал: 201")),
    "oversized offline feed batches must be attributed with role and row count",
  );
  stateAfterDeletion = await request("/api/state", { headers: ownerHeaders });
  const parallelStates = [1, 2].map((marker) => ({
    ...stateAfterDeletion.data.state,
    auditLog: [{ marker }, ...(stateAfterDeletion.data.state.auditLog ?? []).slice(0, 1_999)],
  }));
  const parallelWrites = await Promise.all(parallelStates.map((candidate) => fetch(new URL("/api/state", baseUrl), {
    method: "PUT",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({ state: candidate, expectedRevision: stateAfterDeletion.data.revision }),
  })));
  assert.deepEqual(parallelWrites.map((response) => response.status).sort(), [200, 409]);
  const currentBeforeRestore = await request("/api/state", { headers: ownerHeaders });
  const history = await request("/api/state/history", { headers: ownerHeaders });
  assert.ok(history.data.revisions.length >= 2);
  assert.ok(history.data.revisions.length <= 500);
  assert.ok(history.data.revisions.every((entry) => Number(entry.sizeBytes) > 0));
  assert.ok(history.data.revisions.every((entry) => !Number.isNaN(Date.parse(entry.archivedAt))));
  assert.ok(
    history.data.revisions.some((entry) => Boolean(entry.pinned) && entry.reason === "product_delete"),
    "the snapshot before a product deletion must remain pinned",
  );
  const targetRevision = history.data.revisions.find(
    (entry) => entry.revision < currentBeforeRestore.data.revision,
  ).revision;
  const archived = await request(`/api/state/history?revision=${targetRevision}`, { headers: ownerHeaders });
  assert.ok(Number(archived.data.sizeBytes) > 0);
  assert.ok(!Number.isNaN(Date.parse(archived.data.archivedAt)));
  await request("/api/state/history", {
    method: "POST",
    headers: { cookie: roleCookies.admin, "content-type": "application/json" },
    body: JSON.stringify({ revision: targetRevision, expectedRevision: currentBeforeRestore.data.revision }),
  }, 403);
  const restored = await request("/api/state/history", {
    method: "POST",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({ revision: targetRevision, expectedRevision: currentBeforeRestore.data.revision }),
  });
  assert.equal(restored.data.revision, currentBeforeRestore.data.revision + 1);
  assert.equal(restored.data.restoredFrom, targetRevision);
  const stateAfterRestore = await request("/api/state", { headers: ownerHeaders });
  assert.deepEqual(stateAfterRestore.data.state, archived.data.state);

  const onePixelPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  await request("/api/media/images", {
    method: "POST",
    headers: { cookie: roleCookies.worker, "content-type": "application/json" },
    body: JSON.stringify({ dataUrl: onePixelPng }),
  }, 403);
  const uploaded = await request("/api/media/images", {
    method: "POST",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({ dataUrl: onePixelPng }),
  }, 201);
  assert.match(uploaded.data.key, /^images\//);
  const imageResponse = await fetch(new URL(uploaded.data.url, baseUrl), { headers: ownerHeaders });
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get("content-type"), "image/png");
  assert.ok((await imageResponse.arrayBuffer()).byteLength > 0);
  await request(`/api/media/images?key=${encodeURIComponent(uploaded.data.key)}`, {
    method: "DELETE",
    headers: ownerHeaders,
  });
  await request(`/api/media/images?key=${encodeURIComponent(uploaded.data.key)}`, {
    headers: ownerHeaders,
  }, 404);
} finally {
  for (const device of pushDevices) {
    await request("/api/devices/register", {
      method: "DELETE",
      headers: { cookie: roleCookies[device.role], "content-type": "application/json" },
      body: JSON.stringify({ deviceId: device.deviceId }),
    });
  }
  for (const id of createdIds.reverse()) {
    await request(`/api/users?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: ownerHeaders,
    });
  }
}

const remaining = await request("/api/users", { headers: ownerHeaders });
assert.equal(remaining.data.users.some((user) => createdIds.includes(user.id)), false);

console.log(JSON.stringify({
  ok: true,
  createdAndDeletedUsers: 3,
  ownerDeletionProtected: true,
  stateEndpointAuthenticated: true,
  staleStateWriteRejected: true,
  parallelStateRaceResolved: true,
  authFieldsStrippedFromState: true,
  mediaUploadReadDelete: true,
  workerStateWriteRejected: true,
  usedProductDeletionProtected: true,
  everyStateWriteAudited: true,
  parallelLoginThrottleEnforced: true,
  crossOriginStateWriteRejected: true,
  pushRecipientRoutingVerified: true,
  disabledPushDeliveryTerminalVerified: disabledDeliveryTerminalVerified,
  timingsMs: timings,
}, null, 2));
