import { env } from "cloudflare:workers";
import { audit, createSession, ensureAuthSchema, verifyPassword } from "@/lib/auth";

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
  const login = String(body.login ?? "").trim().toLocaleLowerCase("ru");
  const password = String(body.password ?? "");
  const row = await env.DB.prepare(
    "SELECT id, callsign, login, password_hash, role, assignment, status FROM users WHERE login = ?",
  ).bind(login).first<LoginRow>();

  if (!row || row.status !== "active" || !(await verifyPassword(password, row.password_hash))) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    return Response.json({ error: "Неверный логин или пароль" }, { status: 401 });
  }

  const user = { id: row.id, callsign: row.callsign, login: row.login, role: row.role, assignment: row.assignment };
  await env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(new Date().toISOString(), row.id).run();
  await audit(user, "login", "Вход в систему");
  const session = await createSession(row.id);
  return Response.json({ user }, { headers: { "set-cookie": session.cookie } });
}
