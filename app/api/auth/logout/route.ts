import { audit, clearSessionCookie, deleteSession, getSessionUser } from "@/lib/auth";

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  await deleteSession(request);
  await audit(user, "logout", "Выход из системы");
  return Response.json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
}
