import { env } from "cloudflare:workers";
import { audit, createSession, ensureAuthSchema, hashPassword } from "@/lib/auth";

export async function POST(request: Request) {
  await ensureAuthSchema();
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
  if (Number(count?.count ?? 0) > 0) return Response.json({ error: "Владелец уже создан" }, { status: 409 });

  const body = (await request.json()) as Record<string, unknown>;
  const callsign = String(body.callsign ?? "").trim();
  const login = String(body.login ?? "").trim().toLocaleLowerCase("ru");
  const password = String(body.password ?? "");
  if (callsign.length < 2 || login.length < 3 || password.length < 8) {
    return Response.json({ error: "Позывной — от 2 символов, логин — от 3, пароль — от 8" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO users (id, callsign, login, password_hash, role, assignment, status, created_at) VALUES (?, ?, ?, ?, 'owner', '', 'active', ?)",
  ).bind(id, callsign, login, await hashPassword(password), new Date().toISOString()).run();
  const user = { id, callsign, login, role: "owner" as const, assignment: "" };
  await audit(user, "owner_created", "Создан владелец системы");
  const session = await createSession(id);
  return Response.json({ user }, { status: 201, headers: { "set-cookie": session.cookie } });
}
