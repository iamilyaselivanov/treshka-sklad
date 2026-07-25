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
const auth = await authenticateOwner();
const ownerHeaders = { cookie: auth.cookie };
roleCookies.owner = auth.cookie;
timings.ownerAuthentication = auth.elapsedMs;

try {
  const definitions = [
    { callsign: "Тест-админ", login: `admin-${suffix}`, password: "AdminPass-1600", role: "admin", assignment: "" },
    { callsign: "Тест-кладовщик", login: `store-${suffix}`, password: "StorePass-1600", role: "storekeeper", assignment: "" },
    { callsign: "Тест-работник", login: `worker-${suffix}`, password: "WorkerPass-1600", role: "worker", assignment: "ТЭЧ" },
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

  const bruteTarget = definitions.find((definition) => definition.role === "worker");
  const parallelFailures = await Promise.all(Array.from({ length: 5 }, () =>
    fetch(new URL("/api/auth/login", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: bruteTarget.login, password: "Definitely-Wrong-1600" }),
    })));
  assert.deepEqual(parallelFailures.map((response) => response.status), [401, 401, 401, 401, 401]);
  await request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login: bruteTarget.login, password: bruteTarget.password }),
  }, 429);

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
    { actor: "worker", type: "defect_act_created", targets: 3 },
    { actor: "worker", type: "work_act_created", targets: 3 },
    { actor: "storekeeper", type: "storekeeper_post_issue_completed", targets: 2 },
    { actor: "storekeeper", type: "storekeeper_warehouse_return_accepted", targets: 2 },
  ];
  for (const pushCase of pushCases) {
    const event = await request("/api/notifications/events", {
      method: "POST",
      headers: { cookie: roleCookies[pushCase.actor], "content-type": "application/json" },
      body: JSON.stringify({
        eventId: crypto.randomUUID(),
        type: pushCase.type,
        post: "ТЭЧ",
        entityNo: `TEST-${pushCase.type}`,
        summary: "Проверка маршрутизации push",
      }),
    }, [200, 503]);
    assert.equal(event.data.targetDevices, pushCase.targets, `${pushCase.type} recipient routing`);
    if (event.response.status === 503) {
      assert.equal(
        Number(event.data.failed ?? 0) + Number(event.data.disabled ?? 0),
        pushCase.targets,
        `${pushCase.type} failed deliveries remain retryable`,
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
  await request("/api/devices/register", {
    method: "POST",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      deviceId: crypto.randomUUID(),
      token: `owner-over-limit-${suffix}`.padEnd(96, "x"),
      platform: "android",
      appVersion: "1.6",
    }),
  }, 429);

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
  timings.stateBootstrap = state.elapsedMs;

  const sharedState = state.data.state ?? {
    schemaVersion: 4,
    items: [],
    posts: [{ id: "post-test", name: "ТЭЧ", stock: [], repairs: [] }],
    docs: [],
    extIssues: [],
    stockTransfers: [],
    inventoryActs: [],
    auditLog: [],
  };
  sharedState.accounts = [{ id: "must-not-be-stored", role: "owner" }];
  sharedState.currentAccountId = "must-not-be-stored";
  sharedState.currentRole = "admin";
  await request("/api/state", {
    method: "PUT",
    headers: {
      ...ownerHeaders,
      "content-type": "application/json",
      origin: "https://untrusted.example",
      "sec-fetch-site": "cross-site",
    },
    body: JSON.stringify({ state: sharedState, expectedRevision: state.data.revision }),
  }, 403);
  await request("/api/state", {
    method: "PUT",
    headers: { cookie: roleCookies.worker, "content-type": "application/json" },
    body: JSON.stringify({ state: sharedState, expectedRevision: state.data.revision }),
  }, 403);
  const saved = await request("/api/state", {
    method: "PUT",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({ state: sharedState, expectedRevision: state.data.revision }),
  });
  assert.equal(saved.data.revision, state.data.revision + 1);
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
  await request("/api/state", {
    method: "PUT",
    headers: { cookie: roleCookies.storekeeper, "content-type": "application/json" },
    body: JSON.stringify({ state: stateWithoutDeletionProbe, expectedRevision: deletionProbeSaved.data.revision }),
  }, 403);
  await request("/api/state", {
    method: "PUT",
    headers: { cookie: roleCookies.admin, "content-type": "application/json" },
    body: JSON.stringify({ state: stateWithoutDeletionProbe, expectedRevision: deletionProbeSaved.data.revision }),
  }, 409);
  const originalDocs = stateWithDeletionProbe.docs ?? [];
  const stateWithDocumentReference = {
    ...stateWithDeletionProbe,
    items: stateWithDeletionProbe.items.map((item) =>
      item.id === deletionProbeId ? { ...item, stock: 0 } : item),
    docs: [...originalDocs, { no: `DOC-${suffix}`, kind: "work", itemId: deletionProbeId, materials: [] }],
  };
  const documentReferenceSaved = await request("/api/state", {
    method: "PUT",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      state: stateWithDocumentReference,
      expectedRevision: deletionProbeSaved.data.revision,
    }),
  });
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
    docs: originalDocs,
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
  const stateAfterDeletion = await request("/api/state", { headers: ownerHeaders });
  assert.equal(stateAfterDeletion.data.revision, adminDeletion.data.revision);
  assert.equal(stateAfterDeletion.data.state.items.some((item) => item.id === deletionProbeId), false);
  const parallelStates = [1, 2].map((marker) => ({
    ...stateAfterDeletion.data.state,
    auditLog: [...(stateAfterDeletion.data.state.auditLog ?? []), { marker }],
  }));
  const parallelWrites = await Promise.all(parallelStates.map((candidate) => fetch(new URL("/api/state", baseUrl), {
    method: "PUT",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({ state: candidate, expectedRevision: stateAfterDeletion.data.revision }),
  })));
  assert.deepEqual(parallelWrites.map((response) => response.status).sort(), [200, 409]);

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
  timingsMs: timings,
}, null, 2));
