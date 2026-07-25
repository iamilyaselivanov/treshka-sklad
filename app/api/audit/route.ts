import { env } from "cloudflare:workers";
import { requireUser } from "@/lib/auth";

export async function GET(request: Request) {
  const auth = await requireUser(request, ["owner", "admin"]);
  if (auth.response) return auth.response;
  const result = await env.DB.prepare(
    "SELECT id, callsign, action, details, created_at AS createdAt FROM audit_log ORDER BY created_at DESC LIMIT 200",
  ).all();
  return Response.json({ entries: result.results ?? [] });
}
