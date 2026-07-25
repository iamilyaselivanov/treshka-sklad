import { audit, clearSessionCookie, deleteSession, getSessionUser, isTrustedMutationRequest } from "@/lib/auth";

export async function POST(request: Request) {
  if (!isTrustedMutationRequest(request)) {
    return Response.json({ error: "Недоверенный источник запроса" }, { status: 403 });
  }
  const user = await getSessionUser(request);
  await deleteSession(request);
  if (user) await audit(user, "logout", "Выход из системы");
  return Response.json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
}
