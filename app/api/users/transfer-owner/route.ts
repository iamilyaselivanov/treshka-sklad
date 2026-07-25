import { env } from "cloudflare:workers";
import { audit, clearSessionCookie, requireUser, verifyPassword } from "@/lib/auth";
import { readJsonObject } from "@/lib/http";

export async function POST(request: Request) {
  const auth = await requireUser(request, ["owner"]);
  if (auth.response || !auth.user) return auth.response;
  const body = await readJsonObject(request);
  if (!body) return Response.json({ error: "Некорректный JSON" }, { status: 400 });
  const targetId = String(body.targetUserId ?? "");
  const password = String(body.currentPassword ?? "");
  const current = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?")
    .bind(auth.user.id).first<{ password_hash: string }>();
  if (!current || !(await verifyPassword(password, current.password_hash))) {
    return Response.json({ error: "Пароль владельца указан неверно" }, { status: 403 });
  }
  const target = await env.DB.prepare(
    "SELECT id, callsign, role, status FROM users WHERE id = ?",
  ).bind(targetId).first<{ id: string; callsign: string; role: string; status: string }>();
  if (!target || target.status !== "active" || target.role === "owner") {
    return Response.json({ error: "Выберите активного сотрудника" }, { status: 400 });
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(auth.user.id),
    env.DB.prepare("UPDATE users SET role = 'owner' WHERE id = ?").bind(target.id),
    env.DB.prepare("DELETE FROM sessions"),
  ]);
  await audit(auth.user, "owner_transferred", `Новый владелец: ${target.callsign}`);
  return Response.json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
}
