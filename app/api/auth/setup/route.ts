import { env } from "cloudflare:workers";
import {
  audit,
  clearThrottle,
  clientThrottleKey,
  createSession,
  hashPassword,
  isThrottleBlocked,
  recordThrottleFailure,
  secureEqual,
} from "@/lib/auth";
import { readJsonObject } from "@/lib/http";

export async function POST(request: Request) {
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
  if (Number(count?.count ?? 0) > 0) {
    return Response.json(
      { error: "Владелец уже создан" },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }

  const body = await readJsonObject(request);
  if (!body) return Response.json({ error: "Некорректный JSON" }, { status: 400 });
  const runtimeEnv = env as typeof env & { INITIAL_SETUP_CODE?: string };
  const setupCode = String(body.setupCode ?? "");
  const throttleKey = clientThrottleKey(request, "setup");
  const now = new Date();
  const blockMs = 30 * 60 * 1000;
  if (await isThrottleBlocked(throttleKey, blockMs, now)) {
    return Response.json({ error: "Слишком много попыток. Повторите через 30 минут" }, { status: 429 });
  }
  if (!runtimeEnv.INITIAL_SETUP_CODE || !(await secureEqual(setupCode, runtimeEnv.INITIAL_SETUP_CODE))) {
    await recordThrottleFailure(throttleKey, 5, blockMs, now);
    await new Promise((resolve) => setTimeout(resolve, 500));
    return Response.json({ error: "Неверный код первичной настройки" }, { status: 403 });
  }
  const callsign = String(body.callsign ?? "").trim();
  const login = String(body.login ?? "").trim().toLocaleLowerCase("ru");
  const password = String(body.password ?? "");
  if (callsign.length < 2 || callsign.length > 80 || login.length < 3 || login.length > 120 || password.length < 8 || password.length > 256) {
    return Response.json({ error: "Позывной — от 2 символов, логин — от 3, пароль — от 8" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      "INSERT INTO users (id, callsign, login, password_hash, role, assignment, status, created_at) VALUES (?, ?, ?, ?, 'owner', '', 'active', ?)",
    ).bind(id, callsign, login, await hashPassword(password), new Date().toISOString()).run();
  } catch {
    return Response.json({ error: "Владелец уже создан" }, { status: 409 });
  }
  await clearThrottle(throttleKey);
  const user = { id, callsign, login, role: "owner" as const, assignment: "" };
  await audit(user, "owner_created", "Создан владелец системы");
  const session = await createSession(id);
  return Response.json(
    { user },
    { status: 201, headers: { "set-cookie": session.cookie, "cache-control": "no-store" } },
  );
}
