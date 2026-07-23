import { env } from "cloudflare:workers";
import { audit, createSession, ensureAuthSchema, hashPassword, secureEqual } from "@/lib/auth";

export async function POST(request: Request) {
  await ensureAuthSchema();
  const runtimeEnv = env as typeof env & { OWNER_RECOVERY_CODE?: string };
  const body = (await request.json()) as Record<string, unknown>;
  const loginInput = String(body.login ?? "").trim();
  const login = loginInput.toLocaleLowerCase("ru");
  const callsign = String(body.callsign ?? "").trim() || loginInput;
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
  if (login.length < 3) return Response.json({ error: "Логин должен содержать минимум 3 символа" }, { status: 400 });
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
  let owner = await env.DB.prepare(
    "SELECT id, callsign, login, role, assignment FROM users WHERE role = 'owner' LIMIT 1",
  ).first<{ id: string; callsign: string; login: string; role: "owner"; assignment: string }>();

  let created = false;
  const passwordHash = await hashPassword(password);
  if (!owner) {
    const id = crypto.randomUUID();
    try {
      await env.DB.prepare(
        "INSERT INTO users (id, callsign, login, password_hash, role, assignment, status, created_at) VALUES (?, ?, ?, ?, 'owner', '', 'active', ?)",
      ).bind(id, callsign, login, passwordHash, now.toISOString()).run();
      owner = { id, callsign, login, role: "owner", assignment: "" };
      created = true;
    } catch {
      owner = await env.DB.prepare(
        "SELECT id, callsign, login, role, assignment FROM users WHERE role = 'owner' LIMIT 1",
      ).first<{ id: string; callsign: string; login: string; role: "owner"; assignment: string }>();
      if (!owner) {
        return Response.json(
          { error: "Не удалось сохранить владельца. Повторите через несколько секунд" },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }
    }
  }

  await env.DB.prepare("DELETE FROM login_throttle WHERE login = ?").bind(throttleKey).run();
  if (!created) {
    try {
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE users SET callsign = ?, login = ?, password_hash = ?, status = 'active' WHERE id = ?",
        ).bind(callsign, login, passwordHash, owner.id),
        env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(owner.id),
      ]);
    } catch {
      return Response.json(
        { error: "Этот логин занят другим аккаунтом. Укажите другой логин" },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    }
    owner = { ...owner, callsign, login };
  }
  await audit(null, created ? "owner_created_from_recovery" : "owner_recovered", `${created ? "Создан" : "Восстановлен доступ"} владельца ${owner.callsign}`);
  const session = await createSession(owner.id);
  return Response.json(
    { user: owner },
    { headers: { "set-cookie": session.cookie, "cache-control": "no-store" } },
  );
}
