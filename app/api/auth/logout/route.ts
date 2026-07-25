import { env } from "cloudflare:workers";
import { audit, clearSessionCookie, deleteSession, getSessionUser, isTrustedMutationRequest } from "@/lib/auth";
import { readJsonObject } from "@/lib/http";

const deviceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  if (!isTrustedMutationRequest(request)) {
    return Response.json({ error: "Недоверенный источник запроса" }, { status: 403 });
  }
  const user = await getSessionUser(request);
  const body = request.headers.get("content-type") ? await readJsonObject(request) : null;
  const deviceId = String(body?.deviceId ?? "").trim();
  if (deviceId && !deviceIdPattern.test(deviceId)) {
    return Response.json({ error: "Некорректный идентификатор устройства" }, { status: 400 });
  }
  if (user && deviceId) {
    await env.DB.prepare(
      "DELETE FROM push_devices WHERE user_id = ? AND device_id = ?",
    ).bind(user.id, deviceId).run();
  }
  await deleteSession(request);
  if (user) await audit(user, "logout", "Выход из системы");
  return Response.json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
}
