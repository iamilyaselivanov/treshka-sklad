import { env } from "cloudflare:workers";
import { audit, requireUser } from "@/lib/auth";
import { readJsonObject } from "@/lib/http";

export const dynamic = "force-dynamic";

type ProductRow = {
  id: string;
  name: string;
  sku: string;
  category: string;
  quantity: number;
  unit: string;
  location: string;
  minimum: number;
  created_at: string;
};

function product(row: ProductRow) {
  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    category: row.category,
    quantity: row.quantity,
    unit: row.unit,
    location: row.location,
    minimum: row.minimum,
    createdAt: row.created_at,
  };
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const result = await env.DB.prepare(
    "SELECT id, name, sku, category, quantity, unit, location, minimum, created_at FROM products ORDER BY created_at DESC",
  ).all<ProductRow>();
  return Response.json({ products: (result.results ?? []).map(product) });
}

export async function POST(request: Request) {
  const auth = await requireUser(request, ["owner", "admin", "storekeeper"]);
  if (auth.response || !auth.user) return auth.response;
  const body = await readJsonObject(request);
  if (!body) return Response.json({ error: "Некорректный JSON" }, { status: 400 });
  const name = String(body.name ?? "").trim();
  const sku = String(body.sku ?? "").trim();
  const category = String(body.category ?? "").trim();
  const unit = String(body.unit ?? "шт").trim() || "шт";
  const location = String(body.location ?? "").trim();
  const quantity = Number(body.quantity ?? 0);
  const minimum = Number(body.minimum ?? 0);

  if (!name || !sku) return Response.json({ error: "Укажите название и артикул" }, { status: 400 });
  if (!Number.isFinite(quantity) || quantity < 0 || !Number.isFinite(minimum) || minimum < 0) {
    return Response.json({ error: "Количество и минимум должны быть неотрицательными числами" }, { status: 400 });
  }

  const row: ProductRow = {
    id: crypto.randomUUID(),
    name,
    sku,
    category,
    quantity,
    unit,
    location,
    minimum,
    created_at: new Date().toISOString(),
  };

  try {
    await env.DB.prepare(
      "INSERT INTO products (id, name, sku, category, quantity, unit, location, minimum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(row.id, row.name, row.sku, row.category, row.quantity, row.unit, row.location, row.minimum, row.created_at).run();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    if (message.includes("UNIQUE")) return Response.json({ error: "Товар с таким артикулом уже существует" }, { status: 409 });
    throw cause;
  }

  await audit(auth.user, "product_created", `${row.name} · ${row.sku}`);
  return Response.json({ product: product(row) }, { status: 201 });
}

export async function DELETE(request: Request) {
  const auth = await requireUser(request, ["owner", "admin", "storekeeper"]);
  if (auth.response || !auth.user) return auth.response;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "Не указан товар" }, { status: 400 });
  const existing = await env.DB.prepare("SELECT name, sku FROM products WHERE id = ?").bind(id).first<{ name: string; sku: string }>();
  await env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
  if (existing) await audit(auth.user, "product_deleted", `${existing.name} · ${existing.sku}`);
  return Response.json({ ok: true });
}
