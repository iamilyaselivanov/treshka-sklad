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

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    callsign: text("callsign").notNull(),
    login: text("login").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["owner", "admin", "storekeeper", "worker"] }).notNull(),
    assignment: text("assignment").notNull().default(""),
    status: text("status", { enum: ["active", "blocked"] }).notNull().default("active"),
    createdAt: text("created_at").notNull(),
    lastLoginAt: text("last_login_at"),
  },
  (table) => [index("users_role_idx").on(table.role)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("sessions_user_idx").on(table.userId)],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    callsign: text("callsign").notNull(),
    action: text("action").notNull(),
    details: text("details").notNull().default(""),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("audit_created_idx").on(table.createdAt)],
);
