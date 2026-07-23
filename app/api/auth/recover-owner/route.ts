import { env } from "cloudflare:workers";
import { audit, createSession, ensureAuthSchema, hashPassword, secureEqual } from "@/lib/auth";

export async function POST(request: Request) {
  await ensureAuthSchema();
  const runtimeEnv = env as typeof env & { OWNER_RECOVERY_CODE?: string };
  const body = (await request.json()) as Record<string, unknown>;
  const login = String(body.login ?? "").trim().toLocaleLowerCase("ru");
  const recoveryCode = String(body.recoveryCode ?? "");
  const password = String(body.password ?? "");
  const throttleKey = `recovery:${login}`;
  const now = new Date();
  const throttle = await env.DB.prepare(
    "SELECT failures, blocked_until FROM login_throttle WHERE login = ?",
  ).bind(throttleKey).first<{ failures: number; blocked_until: string | null }>();
  if (throttle?.blocked_until && throttle.blocked_until > now.toISOString()) {
    return Response.json({ error: "Слишком много попыток. Повторите через 30 минут" }, { status: 429 });
  }
  if (password.length < 8) return Response.json({ error: "Пароль должен содержать минимум 8 символов" }, { status: 400 });
  if (!runtimeEnv.OWNER_RECOVERY_CODE || !(await secureEqual(recoveryCode, runtimeEnv.OWNER_RECOVERY_CODE))) {
    const failures = Number(throttle?.failures ?? 0) + 1;
    const blockedUntil = failures >= 5 ? new Date(now.getTime() + 30 * 60 * 1000).toISOString() : null;
    await env.DB.prepare(
      `INSERT INTO login_throttle (login, failures, blocked_until, last_attempt_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(login) DO UPDATE SET failures = excluded.failures,
       blocked_until = excluded.blocked_until, last_attempt_at = excluded.last_attempt_at`,
    ).bind(throttleKey, failures >= 5 ? 0 : failures, blockedUntil, now.toISOString()).run();
    await new Promise((resolve) => setTimeout(resolve, 500));
    return Response.json({ error: "Неверный код аварийного восстановления" }, { status: 403 });
  }
  const owner = await env.DB.prepare(
    "SELECT id, callsign, login, role, assignment FROM users WHERE login = ? AND role = 'owner'",
  ).bind(login).first<{ id: string; callsign: string; login: string; role: "owner"; assignment: string }>();
  if (!owner) return Response.json({ error: "Аккаунт владельца не найден" }, { status: 404 });
  await env.DB.prepare("DELETE FROM login_throttle WHERE login = ?").bind(throttleKey).run();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ?, status = 'active' WHERE id = ?").bind(await hashPassword(password), owner.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(owner.id),
  ]);
  await audit(null, "owner_recovered", `Восстановлен доступ владельца ${owner.callsign}`);
  const session = await createSession(owner.id);
  return Response.json({ user: owner }, { headers: { "set-cookie": session.cookie } });
}
