import { env } from "cloudflare:workers";
import {
  audit,
  burnPasswordVerification,
  clientThrottleKey,
  createSession,
  ensureAuthSchema,
  registerThrottleFailure,
  sweepThrottleTableOccasionally,
  verifyPassword,
} from "@/lib/auth";

type LoginRow = {
  id: string;
  callsign: string;
  login: string;
  password_hash: string;
  role: "owner" | "admin" | "storekeeper" | "worker";
  assignment: string;
  status: string;
};

const BLOCK_MINUTES = 15;

export async function POST(request: Request) {
  await ensureAuthSchema();
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Некорректный JSON" }, { status: 400 });
  }
  const login = String(body.login ?? "").trim().toLocaleLowerCase("ru").slice(0, 120);
  const password = String(body.password ?? "");
  if (login.length < 3 || password.length < 8 || password.length > 256) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    return Response.json({ error: "Неверный логин или пароль" }, { status: 401 });
  }
  const throttleKey = clientThrottleKey(request, "login", login);
  const now = new Date();
  const throttle = await env.DB.prepare(
    "SELECT blocked_until FROM login_throttle WHERE login = ?",
  ).bind(throttleKey).first<{ blocked_until: string | null }>();
  if (throttle?.blocked_until && throttle.blocked_until > now.toISOString()) {
    return Response.json(
      { error: `Слишком много попыток. Повторите вход через ${BLOCK_MINUTES} минут` },
      { status: 429 },
    );
  }
  const row = await env.DB.prepare(
    "SELECT id, callsign, login, password_hash, role, assignment, status FROM users WHERE login = ?",
  ).bind(login).first<LoginRow>();

  // PBKDF2 считается всегда — и для несуществующего, и для заблокированного
  // логина, — чтобы время ответа не выдавало существование учётной записи.
  const passwordOk = row && row.status === "active"
    ? await verifyPassword(password, row.password_hash)
    : await burnPasswordVerification(password);

  if (!row || row.status !== "active" || !passwordOk) {
    await registerThrottleFailure(throttleKey, now, BLOCK_MINUTES);
    await sweepThrottleTableOccasionally(now);
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
