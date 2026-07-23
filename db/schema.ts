import { index, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const products = sqliteTable(
  "products",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    sku: text("sku").notNull().unique(),
    category: text("category").notNull().default(""),
    quantity: real("quantity").notNull().default(0),
    unit: text("unit").notNull().default("шт"),
    location: text("location").notNull().default(""),
    minimum: real("minimum").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("products_name_idx").on(table.name)],
);
