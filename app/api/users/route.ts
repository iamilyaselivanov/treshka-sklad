import { env } from "cloudflare:workers";
import { audit, hashPassword, requireUser, Role } from "@/lib/auth";
import { readJsonObject } from "@/lib/http";
import { normalizePostAssignment } from "@/lib/push-events";

export const dynamic = "force-dynamic";

const allowedRoles: Role[] = ["admin", "storekeeper", "worker"];

export async function GET(request: Request) {
  const auth = await requireUser(request, ["owner", "admin"]);
  if (auth.response) return auth.response;
  const result = await env.DB.prepare(
    "SELECT id, callsign, login, role, assignment, status, created_at AS createdAt, last_login_at AS lastLoginAt FROM users ORDER BY role, callsign",
  ).all();
  return Response.json({ users: result.results ?? [] });
}

export async function POST(request: Request) {
  const auth = await requireUser(request, ["owner", "admin"]);
  if (auth.response || !auth.user) return auth.response;
  const body = await readJsonObject(request);
  if (!body) return Response.json({ error: "Некорректный JSON" }, { status: 400 });
  const callsign = String(body.callsign ?? "").trim();
  const login = String(body.login ?? "").trim().toLocaleLowerCase("ru");
  const password = String(body.password ?? "");
  const role = String(body.role ?? "") as Role;
  const assignment = String(body.assignment ?? "").trim();
  const assignmentKey = normalizePostAssignment(assignment);
  if (
    callsign.length < 2 || callsign.length > 80
    || login.length < 3 || login.length > 120
    || password.length < 8 || password.length > 256
    || assignment.length > 160
    || !allowedRoles.includes(role)
    || (role === "worker" && !assignmentKey)
  ) {
    return Response.json({ error: "Проверьте позывной, логин, пароль и роль" }, { status: 400 });
  }
  if (auth.user.role === "admin" && role === "admin") {
    return Response.json({ error: "Назначать администраторов может только владелец" }, { status: 403 });
  }
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      "INSERT INTO users (id, callsign, login, password_hash, role, assignment, assignment_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)",
    ).bind(id, callsign, login, await hashPassword(password), role, assignment, assignmentKey, new Date().toISOString()).run();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    if (message.includes("UNIQUE")) return Response.json({ error: "Такой логин уже занят" }, { status: 409 });
    throw cause;
  }
  await audit(auth.user, "user_created", `${callsign} · ${role}`);
  return Response.json({ user: { id, callsign, login, role, assignment, status: "active" } }, { status: 201 });
}

export async function PATCH(request: Request) {
  const auth = await requireUser(request, ["owner", "admin"]);
  if (auth.response || !auth.user) return auth.response;
  const body = await readJsonObject(request);
  if (!body) return Response.json({ error: "Некорректный JSON" }, { status: 400 });
  const id = String(body.id ?? "");
  const status = String(body.status ?? "");
  const password = String(body.password ?? "");
  const target = await env.DB.prepare("SELECT id, callsign, role FROM users WHERE id = ?").bind(id).first<{ id: string; callsign: string; role: Role }>();
  if (!target) return Response.json({ error: "Сотрудник не найден" }, { status: 404 });
  if (target.role === "owner") return Response.json({ error: "Аккаунт владельца нельзя изменить здесь" }, { status: 403 });
  if (auth.user.role === "admin" && target.role === "admin") return Response.json({ error: "Недостаточно прав" }, { status: 403 });

  if (password) {
    if (password.length < 8 || password.length > 256) return Response.json({ error: "Пароль должен содержать от 8 до 256 символов" }, { status: 400 });
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(password), id).run();
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
    await audit(auth.user, "password_reset", target.callsign);
  } else if (status === "active" || status === "blocked") {
    await env.DB.prepare("UPDATE users SET status = ? WHERE id = ?").bind(status, id).run();
    if (status === "blocked") await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
    await audit(auth.user, "user_status_changed", `${target.callsign} · ${status}`);
  } else {
    return Response.json({ error: "Нет изменений" }, { status: 400 });
  }
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  const auth = await requireUser(request, ["owner", "admin"]);
  if (auth.response || !auth.user) return auth.response;
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const target = await env.DB.prepare(
    "SELECT id, callsign, role FROM users WHERE id = ?",
  ).bind(id).first<{ id: string; callsign: string; role: Role }>();
  if (!target) return Response.json({ error: "Сотрудник не найден" }, { status: 404 });
  if (target.role === "owner") return Response.json({ error: "Аккаунт владельца удалить нельзя" }, { status: 403 });
  if (auth.user.role === "admin" && target.role === "admin") {
    return Response.json({ error: "Удалять администраторов может только владелец" }, { status: 403 });
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM push_devices WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
  ]);
  await audit(auth.user, "user_deleted", `${target.callsign} · ${target.role}`);
  return Response.json({ ok: true });
}
