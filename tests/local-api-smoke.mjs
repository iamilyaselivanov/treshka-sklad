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
  const data = await response.json();
  assert.equal(response.status, expected, `${init.method ?? "GET"} ${path}: ${JSON.stringify(data)}`);
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
const timings = {};
const auth = await authenticateOwner();
const ownerHeaders = { cookie: auth.cookie };
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
    timings[`login_${definition.role}`] = login.elapsedMs;
  }

  const users = await request("/api/users", { headers: ownerHeaders });
  assert.equal(users.data.users.filter((user) => createdIds.includes(user.id)).length, 3);

  await request(`/api/users?id=${encodeURIComponent(auth.user.id)}`, {
    method: "DELETE",
    headers: ownerHeaders,
  }, 403);

  const state = await request("/api/state", { headers: ownerHeaders });
  assert.equal(state.data.user.id, auth.user.id);
  assert.ok(Number.isInteger(state.data.revision));
  timings.stateBootstrap = state.elapsedMs;

  if (!state.data.state) {
    const saved = await request("/api/state", {
      method: "PUT",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        state: {
          schemaVersion: 3,
          items: [],
          posts: [{ id: "post-test", name: "ТЭЧ", stock: [] }],
          documents: [],
        },
      }),
    });
    assert.equal(saved.data.revision, 1);
  }
} finally {
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
  timingsMs: timings,
}, null, 2));
