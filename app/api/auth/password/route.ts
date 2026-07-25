import { env } from "cloudflare:workers";
import { audit, clearSessionCookie, hashPassword, requireUser, verifyPassword } from "@/lib/auth";
import { readJsonObject } from "@/lib/http";

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth.response || !auth.user) return auth.response;
  const body = await readJsonObject(request);
  if (!body) return Response.json({ error: "Некорректный JSON" }, { status: 400 });
  const currentPassword = String(body.currentPassword ?? "");
  const newPassword = String(body.newPassword ?? "");
  if (newPassword.length < 8 || newPassword.length > 256) return Response.json({ error: "Новый пароль должен содержать от 8 до 256 символов" }, { status: 400 });
  const row = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?")
    .bind(auth.user.id).first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(currentPassword, row.password_hash))) {
    return Response.json({ error: "Текущий пароль указан неверно" }, { status: 403 });
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(newPassword), auth.user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(auth.user.id),
  ]);
  await audit(auth.user, "own_password_changed", "Пользователь изменил свой пароль");
  return Response.json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
}
