import { integer, index, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
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
    assignmentKey: text("assignment_key").notNull().default(""),
    status: text("status", { enum: ["active", "blocked"] }).notNull().default("active"),
    createdAt: text("created_at").notNull(),
    lastLoginAt: text("last_login_at"),
  },
  (table) => [
    index("users_role_idx").on(table.role),
    index("users_assignment_key_idx").on(table.assignmentKey),
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
  // Deprecated physical column kept only because migration 0005 already added
  // it on deployed databases. Runtime indexing uses warehouseStateItems.
  legacyItemIds: text("item_ids").notNull().default("[]"),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by").notNull(),
});

export const warehouseStateRevisions = sqliteTable(
  "warehouse_state_revisions",
  {
    stateKey: text("state_key").notNull(),
    revision: integer("revision").notNull(),
    payload: text("payload").notNull(),
    updatedAt: text("updated_at").notNull(),
    updatedBy: text("updated_by").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    archivedAt: text("archived_at").notNull().default(""),
  },
  (table) => [
    primaryKey({ columns: [table.stateKey, table.revision] }),
    index("warehouse_state_revisions_updated_idx").on(table.updatedAt),
    index("warehouse_state_revisions_archived_idx").on(table.archivedAt),
  ],
);

export const warehouseStateItems = sqliteTable(
  "warehouse_state_items",
  {
    stateKey: text("state_key").notNull(),
    itemId: text("item_id").notNull(),
  },
  (table) => [
    uniqueIndex("warehouse_state_items_key_idx").on(table.stateKey, table.itemId),
    index("warehouse_state_items_state_idx").on(table.stateKey),
  ],
);

export const inventoryActCounters = sqliteTable("inventory_act_counters", {
  scope: text("scope").primaryKey(),
  value: integer("value").notNull().default(0),
});

export const inventoryActArchive = sqliteTable(
  "inventory_act_archive",
  {
    id: text("id").primaryKey(),
    number: text("number").notNull().unique(),
    payload: text("payload").notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    actorCallsign: text("actor_callsign").notNull(),
    actorRole: text("actor_role").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("inventory_act_archive_finished_idx").on(table.finishedAt),
    index("inventory_act_archive_actor_idx").on(table.actorUserId),
  ],
);

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
    status: text("status", { enum: ["pending", "sent", "failed", "disabled", "dead"] }).notNull(),
    providerMessageId: text("provider_message_id").notNull().default(""),
    error: text("error").notNull().default(""),
    attemptedAt: text("attempted_at"),
    // Deprecated physical column kept for compatibility with migration 0005.
    // Runtime retry accounting uses pushDeliveryAttempts.
    legacyAttempts: integer("attempts").notNull().default(0),
  },
  (table) => [
    uniqueIndex("push_deliveries_event_device_idx").on(table.eventId, table.deviceId),
    index("push_deliveries_status_idx").on(table.status),
  ],
);

export const pushDeliveryAttempts = sqliteTable("push_delivery_attempts", {
  deliveryId: text("delivery_id").primaryKey(),
  attempts: integer("attempts").notNull().default(0),
});

export const pushMaintenanceState = sqliteTable("push_maintenance_state", {
  id: integer("id").primaryKey(),
  lastRunAt: text("last_run_at").notNull(),
});
