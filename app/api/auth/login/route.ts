import { env } from "cloudflare:workers";
import { audit, clientThrottleKey, createSession, ensureAuthSchema, verifyPassword } from "@/lib/auth";

type LoginRow = {
  id: string;
  callsign: string;
  login: string;
  password_hash: string;
  role: "owner" | "admin" | "storekeeper" | "worker";
  assignment: string;
  status: string;
};

export async function POST(request: Request) {
  await ensureAuthSchema();
  const body = (await request.json()) as Record<string, unknown>;
  const login = String(body.login ?? "").trim().toLocaleLowerCase("ru").slice(0, 120);
  const password = String(body.password ?? "");
  if (login.length < 3 || password.length < 8 || password.length > 256) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    return Response.json({ error: "Неверный логин или пароль" }, { status: 401 });
  }
  const throttleKey = clientThrottleKey(request, "login", login);
  const now = new Date();
  const throttle = await env.DB.prepare(
    "SELECT failures, blocked_until FROM login_throttle WHERE login = ?",
  ).bind(throttleKey).first<{ failures: number; blocked_until: string | null }>();
  if (throttle?.blocked_until && throttle.blocked_until > now.toISOString()) {
    return Response.json({ error: "Слишком много попыток. Повторите вход через 15 минут" }, { status: 429 });
  }
  const row = await env.DB.prepare(
    "SELECT id, callsign, login, password_hash, role, assignment, status FROM users WHERE login = ?",
  ).bind(login).first<LoginRow>();

  if (!row || row.status !== "active" || !(await verifyPassword(password, row.password_hash))) {
    const failures = Number(throttle?.failures ?? 0) + 1;
    const blockedUntil = failures >= 5 ? new Date(now.getTime() + 15 * 60 * 1000).toISOString() : null;
    await env.DB.prepare(
      `INSERT INTO login_throttle (login, failures, blocked_until, last_attempt_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(login) DO UPDATE SET failures = excluded.failures,
       blocked_until = excluded.blocked_until, last_attempt_at = excluded.last_attempt_at`,
    ).bind(throttleKey, failures >= 5 ? 0 : failures, blockedUntil, now.toISOString()).run();
    await new Promise((resolve) => setTimeout(resolve, 350));
    return Response.json({ error: "Неверный логин или пароль" }, { status: 401 });
  }

  const user = { id: row.id, callsign: row.callsign, login: row.login, role: row.role, assignment: row.assignment };
  await env.DB.batch([
    env.DB.prepare("DELETE FROM login_throttle WHERE login = ?").bind(throttleKey),
    env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(new Date().toISOString(), row.id),
  ]);
  const [session] = await Promise.all([
    createSession(row.id),
    audit(user, "login", "Вход в систему"),
  ]);
  return Response.json({ user }, { headers: { "set-cookie": session.cookie } });
}
