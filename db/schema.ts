import { integer, index, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

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
  (table) => [
    index("users_role_idx").on(table.role),
    uniqueIndex("single_owner_idx").on(table.role).where(sql`${table.role} = 'owner'`),
  ],
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

export const loginThrottle = sqliteTable("login_throttle", {
  login: text("login").primaryKey(),
  failures: integer("failures").notNull().default(0),
  blockedUntil: text("blocked_until"),
  lastAttemptAt: text("last_attempt_at").notNull(),
});

export const warehouseFullState = sqliteTable("warehouse_full_state", {
  stateKey: text("state_key").primaryKey(),
  revision: integer("revision").notNull().default(0),
  payload: text("payload").notNull(),
  itemIds: text("item_ids").notNull().default("[]"),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by").notNull(),
});

export const pushDevices = sqliteTable(
  "push_devices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    deviceId: text("device_id").notNull(),
    token: text("token").notNull(),
    platform: text("platform", { enum: ["android"] }).notNull().default("android"),
    appVersion: text("app_version").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [
    uniqueIndex("push_devices_device_idx").on(table.deviceId),
    uniqueIndex("push_devices_token_idx").on(table.token),
    index("push_devices_user_idx").on(table.userId),
  ],
);

export const pushEvents = sqliteTable(
  "push_events",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id").notNull(),
    eventType: text("event_type").notNull(),
    post: text("post").notNull().default(""),
    entityNo: text("entity_no").notNull().default(""),
    summary: text("summary").notNull().default(""),
    title: text("title").notNull(),
    body: text("body").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("push_events_created_idx").on(table.createdAt)],
);

export const pushDeliveries = sqliteTable(
  "push_deliveries",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    userId: text("user_id").notNull(),
    deviceId: text("device_id").notNull(),
    status: text("status", { enum: ["pending", "sent", "failed", "disabled"] }).notNull(),
    providerMessageId: text("provider_message_id").notNull().default(""),
    error: text("error").notNull().default(""),
    attemptedAt: text("attempted_at"),
    attempts: integer("attempts").notNull().default(0),
  },
  (table) => [
    uniqueIndex("push_deliveries_event_device_idx").on(table.eventId, table.deviceId),
    index("push_deliveries_status_idx").on(table.status),
  ],
);
