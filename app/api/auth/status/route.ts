import { env } from "cloudflare:workers";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const [count, user] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>(),
    getSessionUser(request),
  ]);
  return Response.json(
    { setupRequired: Number(count?.count ?? 0) === 0, user },
    { headers: { "cache-control": "no-store, no-cache, must-revalidate, max-age=0" } },
  );
}
