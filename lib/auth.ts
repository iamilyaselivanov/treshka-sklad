import { env } from "cloudflare:workers";

export type Role = "owner" | "admin" | "storekeeper" | "worker";

export type SessionUser = {
  id: string;
  callsign: string;
  login: string;
  role: Role;
  assignment: string;
};

const ITERATIONS = 310_000;
const SESSION_COOKIE = "treshka_session";
const SESSION_SECONDS = 60 * 60 * 24 * 7;

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
  const db = env.DB;
  await db.batch([
    db.prepare(usersSql),
    db.prepare(sessionsSql),
    db.prepare(auditSql),
    db.prepare(throttleSql),
    db.prepare("CREATE INDEX IF NOT EXISTS users_role_idx ON users(role)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS single_owner_idx ON users(role) WHERE role = 'owner'"),
    db.prepare("CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_log(created_at)"),
  ]);
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
  const expected = base64ToBytes(expectedValue);
  const actual = await derive(password, base64ToBytes(saltValue), Number(iterationsValue));
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ expected[index];
  return difference === 0;
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
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), userId, await digest(token), expires.toISOString(), now.toISOString()).run();
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
  await env.DB.prepare(
    "INSERT INTO audit_log (id, user_id, callsign, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), user?.id ?? null, user?.callsign ?? "Система", action, details, new Date().toISOString()).run();
}
