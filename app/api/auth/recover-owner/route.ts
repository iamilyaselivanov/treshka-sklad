import { env } from "cloudflare:workers";
import {
  addressThrottleKey,
  audit,
  createSession,
  ensureAuthSchema,
  hashPassword,
  registerThrottleFailure,
  secureEqual,
  sweepThrottleTableOccasionally,
} from "@/lib/auth";

const BLOCK_MINUTES = 30;

export async function POST(request: Request) {
  await ensureAuthSchema();
  const runtimeEnv = env as typeof env & { OWNER_RECOVERY_CODE?: string };
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Некорректный JSON" }, { status: 400 });
  }
  const loginInput = String(body.login ?? "").trim();
  const login = loginInput.toLocaleLowerCase("ru");
  const callsign = String(body.callsign ?? "").trim() || loginInput;
  const recoveryCode = String(body.recoveryCode ?? "");
  const password = String(body.password ?? "");
  // Ключ НЕ содержит присланный логин: логин здесь не участвует в проверке
  // доступа (сравнивается только OWNER_RECOVERY_CODE), поэтому, подставляя
  // каждый раз новый логин, перебор кода уходил в новую строку
  // login_throttle со счётчиком 1 и блокировка не наступала никогда.
  const throttleKey = addressThrottleKey(request, "recovery");
  const now = new Date();
  const throttle = await env.DB.prepare(
    "SELECT blocked_until FROM login_throttle WHERE login = ?",
  ).bind(throttleKey).first<{ blocked_until: string | null }>();
  if (throttle?.blocked_until && throttle.blocked_until > now.toISOString()) {
    return Response.json(
      { error: `Слишком много попыток. Повторите через ${BLOCK_MINUTES} минут` },
      { status: 429 },
    );
  }
  if (login.length < 3 || login.length > 120) return Response.json({ error: "Логин должен содержать от 3 до 120 символов" }, { status: 400 });
  if (callsign.length < 2 || callsign.length > 80) return Response.json({ error: "Позывной должен содержать от 2 до 80 символов" }, { status: 400 });
  if (password.length < 8 || password.length > 256) return Response.json({ error: "Пароль должен содержать от 8 до 256 символов" }, { status: 400 });
  if (!runtimeEnv.OWNER_RECOVERY_CODE || !(await secureEqual(recoveryCode, runtimeEnv.OWNER_RECOVERY_CODE))) {
    await registerThrottleFailure(throttleKey, now, BLOCK_MINUTES);
    await sweepThrottleTableOccasionally(now);
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
