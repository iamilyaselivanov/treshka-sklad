import { env } from "cloudflare:workers";
import { audit, clearSessionCookie, ensureAuthSchema, hashPassword, requireUser, verifyPassword } from "@/lib/auth";

export async function POST(request: Request) {
  await ensureAuthSchema();
  const auth = await requireUser(request);
  if (auth.response || !auth.user) return auth.response;
  const body = (await request.json()) as Record<string, unknown>;
  const currentPassword = String(body.currentPassword ?? "");
  const newPassword = String(body.newPassword ?? "");
  if (newPassword.length < 8) return Response.json({ error: "Новый пароль должен содержать минимум 8 символов" }, { status: 400 });
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
