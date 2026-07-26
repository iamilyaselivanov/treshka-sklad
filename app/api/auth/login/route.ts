import { env } from "cloudflare:workers";
import {
  audit,
  clearThrottle,
  clientThrottleKey,
  createSession,
  isThrottleBlocked,
  recordThrottleFailure,
  verifyPassword,
} from "@/lib/auth";
import { readJsonObject } from "@/lib/http";

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
  const body = await readJsonObject(request);
  if (!body) return Response.json({ error: "Некорректный JSON" }, { status: 400 });
  const login = String(body.login ?? "").trim().toLocaleLowerCase("ru").slice(0, 120);
  const password = String(body.password ?? "");
  if (login.length < 3 || password.length < 8 || password.length > 256) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    return Response.json({ error: "Неверный логин или пароль" }, { status: 401 });
  }
  const throttleKey = clientThrottleKey(request, "login", login);
  const globalThrottleKey = clientThrottleKey(request, "login-ip");
  const now = new Date();
  const blockMs = 15 * 60 * 1000;
  if (
    await isThrottleBlocked(throttleKey, blockMs, now)
    || await isThrottleBlocked(globalThrottleKey, blockMs, now)
  ) {
    return Response.json({ error: "Слишком много попыток. Повторите вход через 15 минут" }, { status: 429 });
  }
  // Reserve this attempt atomically before the expensive PBKDF2 work. In a
  // parallel burst only the attempts below the threshold may reach password
  // verification; later requests observe the block set by SQLite RETURNING.
  const reservation = await recordThrottleFailure(throttleKey, 5, blockMs, now);
  // The fifth slot is still verified: a correct password on the final allowed
  // attempt must be able to clear the throttle. Only a concurrent request that
  // reserved a later slot is rejected before PBKDF2.
  if (reservation.failures > 5) {
    return Response.json({ error: "Слишком много попыток. Повторите вход через 15 минут" }, { status: 429 });
  }
  const row = await env.DB.prepare(
    "SELECT id, callsign, login, password_hash, role, assignment, status FROM users WHERE login = ?",
  ).bind(login).first<LoginRow>();

  if (!row || row.status !== "active" || !(await verifyPassword(password, row.password_hash))) {
    // A second IP-wide lane bounds login rotation. It is incremented only for
    // actual failures, so successful logins on a shared warehouse network do
    // not consume its allowance.
    const globalFailure = await recordThrottleFailure(globalThrottleKey, 20, blockMs, now);
    const thresholdCrossed = reservation.failures === 5 || globalFailure.failures === 20;
    await Promise.all([
      new Promise((resolve) => setTimeout(resolve, 350)),
      thresholdCrossed
        ? audit(null, "login_blocked", "Превышен порог неудачных попыток входа")
        : Promise.resolve(),
    ]);
    const blocked = reservation.blocked || globalFailure.blocked;
    return Response.json(
      { error: blocked ? "Слишком много попыток. Повторите вход через 15 минут" : "Неверный логин или пароль" },
      { status: blocked ? 429 : 401 },
    );
  }

  const user = { id: row.id, callsign: row.callsign, login: row.login, role: row.role, assignment: row.assignment };
  await env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), row.id)
    .run();
  await clearThrottle(throttleKey);
  const [session] = await Promise.all([
    createSession(row.id),
    audit(user, "login", "Вход в систему"),
  ]);
  return Response.json({ user }, { headers: { "set-cookie": session.cookie } });
}
