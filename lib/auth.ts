import { env } from "cloudflare:workers";

export type Role = "owner" | "admin" | "storekeeper" | "worker";

export type SessionUser = {
  id: string;
  callsign: string;
  login: string;
  role: Role;
  assignment: string;
};

// Keep password hashing within the Cloudflare Worker CPU budget. The iteration
// count is stored in every hash, so it can be raised later without breaking
// existing accounts.
const ITERATIONS = 100_000;
const SESSION_COOKIE = "treshka_session";
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const AUDIT_RETENTION_DAYS = 180;
const AUDIT_MAX_ROWS = 5_000;
let authSchemaPromise: Promise<unknown> | null = null;

const usersSql = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY NOT NULL,
    callsign TEXT NOT NULL,
    login TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    assignment TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    last_login_at TEXT
  )
`;

const sessionsSql = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`;

const auditSql = `
  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT,
    callsign TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )
`;

const throttleSql = `
  CREATE TABLE IF NOT EXISTS login_throttle (
    login TEXT PRIMARY KEY NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    blocked_until TEXT,
    last_attempt_at TEXT NOT NULL
  )
`;

export async function ensureAuthSchema() {
  if (!authSchemaPromise) {
    const db = env.DB;
    authSchemaPromise = db.batch([
      db.prepare(usersSql),
      db.prepare(sessionsSql),
      db.prepare(auditSql),
      db.prepare(throttleSql),
      db.prepare("CREATE INDEX IF NOT EXISTS users_role_idx ON users(role)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS single_owner_idx ON users(role) WHERE role = 'owner'"),
      db.prepare("CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_log(created_at)"),
    ]).catch((error) => {
      authSchemaPromise = null;
      throw error;
    });
  }
  await authSchemaPromise;
}

export async function secureEqual(left: string, right: string) {
  const leftHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)));
  const rightHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)));
  let difference = leftHash.length ^ rightHash.length;
  for (let index = 0; index < leftHash.length; index += 1) difference |= leftHash[index] ^ rightHash[index];
  return difference === 0;
}

function bytesToBase64(bytes: Uint8Array) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64ToBytes(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function derive(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, iterationsValue, saltValue, expectedValue] = encoded.split("$");
  if (algorithm !== "pbkdf2" || !iterationsValue || !saltValue || !expectedValue) return false;
  const iterations = Number(iterationsValue);
  if (!Number.isInteger(iterations) || iterations < 50_000 || iterations > 1_000_000) return false;
  try {
    const salt = base64ToBytes(saltValue);
    const expected = base64ToBytes(expectedValue);
    if (salt.length < 8 || salt.length > 64 || expected.length !== 32) return false;
    const actual = await derive(password, salt, iterations);
    let difference = 0;
    for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ expected[index];
    return difference === 0;
  } catch {
    return false;
  }
}

async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64(new Uint8Array(bytes));
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

export async function createSession(userId: string) {
  await ensureAuthSchema();
  const token = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_SECONDS * 1000);
  const throttleCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now.toISOString()),
    env.DB.prepare("DELETE FROM login_throttle WHERE last_attempt_at < ?").bind(throttleCutoff),
    env.DB.prepare(
      `DELETE FROM sessions
       WHERE user_id = ? AND id IN (
         SELECT id FROM sessions
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT -1 OFFSET 9
       )`,
    ).bind(userId, userId),
    env.DB.prepare(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), userId, await digest(token), expires.toISOString(), now.toISOString()),
  ]);
  return {
    token,
    cookie: `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`,
  };
}

export async function deleteSession(request: Request) {
  await ensureAuthSchema();
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await digest(token)).run();
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  await ensureAuthSchema();
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT users.id, users.callsign, users.login, users.role, users.assignment
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.status = 'active'`,
  ).bind(await digest(token), new Date().toISOString()).first<SessionUser>();
  return row ?? null;
}

export async function requireUser(request: Request, roles?: Role[]) {
  const user = await getSessionUser(request);
  if (!user) return { user: null, response: Response.json({ error: "Требуется вход" }, { status: 401 }) };
  if (roles && !roles.includes(user.role)) {
    return { user: null, response: Response.json({ error: "Недостаточно прав" }, { status: 403 }) };
  }
  return { user, response: null };
}

export async function audit(user: SessionUser | null, action: string, details = "") {
  await ensureAuthSchema();
  const now = new Date();
  const cutoff = new Date(now.getTime() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO audit_log (id, user_id, callsign, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      crypto.randomUUID(),
      user?.id ?? null,
      (user?.callsign ?? "Система").slice(0, 120),
      action.slice(0, 120),
      details.slice(0, 1_000),
      now.toISOString(),
    ),
    env.DB.prepare("DELETE FROM audit_log WHERE created_at < ?").bind(cutoff),
    env.DB.prepare(
      `DELETE FROM audit_log
       WHERE id IN (
         SELECT id FROM audit_log
         ORDER BY created_at DESC
         LIMIT -1 OFFSET ?
       )`,
    ).bind(AUDIT_MAX_ROWS),
  ]);
}

export function clientThrottleKey(request: Request, scope: string, login = "") {
  const address = (request.headers.get("cf-connecting-ip") ?? "unknown").trim().slice(0, 80);
  return `${scope}:${login.slice(0, 120)}:${address}`;
}
