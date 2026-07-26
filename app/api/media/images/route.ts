import { env } from "cloudflare:workers";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const MAX_IMAGE_BYTES = 500_000;
const IMAGE_PATTERN = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/;

function bucket() {
  return env.MEDIA ?? null;
}

function keyFromRequest(request: Request) {
  const key = new URL(request.url).searchParams.get("key") ?? "";
  return /^images\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/.test(key) ? key : "";
}

function decodeBase64(encoded: string) {
  try {
    const binary = atob(encoded);
    if (binary.length > MAX_IMAGE_BYTES) return null;
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const auth = await requireUser(request, ["owner", "admin", "storekeeper"]);
  if (auth.response) return auth.response;
  const media = bucket();
  if (!media) return Response.json({ error: "Хранилище фотографий не подключено" }, { status: 503 });
  let body: { dataUrl?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Некорректный JSON" }, { status: 400 });
  }
  const match = IMAGE_PATTERN.exec(String(body.dataUrl ?? ""));
  const bytes = match ? decodeBase64(match[2]) : null;
  if (!match || !bytes) {
    return Response.json({ error: "Поддерживаются JPEG, PNG или WebP до 500 КБ" }, { status: 400 });
  }
  const extension = match[1] === "jpeg" ? "jpg" : match[1];
  const key = `images/${crypto.randomUUID()}.${extension}`;
  await media.put(key, bytes, { httpMetadata: { contentType: `image/${match[1]}` } });
  return Response.json({ key, url: `/api/media/images?key=${encodeURIComponent(key)}` }, { status: 201 });
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const media = bucket();
  if (!media) return Response.json({ error: "Хранилище фотографий не подключено" }, { status: 503 });
  const key = keyFromRequest(request);
  if (!key) return Response.json({ error: "Некорректный идентификатор фотографии" }, { status: 400 });
  const object = await media.get(key);
  if (!object) return Response.json({ error: "Фотография не найдена" }, { status: 404 });
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "image/jpeg",
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function DELETE(request: Request) {
  const auth = await requireUser(request, ["owner", "admin", "storekeeper"]);
  if (auth.response) return auth.response;
  const media = bucket();
  if (!media) return Response.json({ error: "Хранилище фотографий не подключено" }, { status: 503 });
  const key = keyFromRequest(request);
  if (!key) return Response.json({ error: "Некорректный идентификатор фотографии" }, { status: 400 });
  await media.delete(key);
  return Response.json({ ok: true });
}
