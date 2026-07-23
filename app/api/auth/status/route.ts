import { env } from "cloudflare:workers";
import { ensureAuthSchema, getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  await ensureAuthSchema();
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
  const user = await getSessionUser(request);
  return Response.json({ setupRequired: Number(count?.count ?? 0) === 0, user });
}
