CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  login text NOT NULL,
  password_hash text NOT NULL,
  legacy_password_hash text,
  legacy_salt text,
  role text NOT NULL CHECK (role IN ('admin','kladovshik','rabotnik')),
  post_name text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, login)
);

CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  device_key text NOT NULL,
  push_token text,
  platform text NOT NULL DEFAULT 'android',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, device_key)
);

CREATE TABLE IF NOT EXISTS warehouse_state (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  revision bigint NOT NULL,
  schema_version integer NOT NULL,
  payload jsonb NOT NULL,
  checksum text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS warehouse_state_revisions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  revision bigint NOT NULL,
  schema_version integer NOT NULL,
  payload jsonb NOT NULL,
  checksum text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id, revision)
);

CREATE TABLE IF NOT EXISTS sync_mutations (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  mutation_id uuid NOT NULL,
  device_id text NOT NULL,
  base_revision bigint NOT NULL,
  applied_revision bigint NOT NULL,
  payload_checksum text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id, mutation_id)
);

CREATE TABLE IF NOT EXISTS conflict_snapshots (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  mutation_id uuid NOT NULL,
  device_id text NOT NULL,
  base_revision bigint NOT NULL,
  server_revision bigint NOT NULL,
  schema_version integer NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE(tenant_id, mutation_id)
);

CREATE TABLE IF NOT EXISTS push_events (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  event_id text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  recipient_login text,
  recipient_role text,
  post_name text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id, event_id)
);

CREATE TABLE IF NOT EXISTS media_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  storage_backend text NOT NULL,
  object_key text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, object_key)
);

CREATE INDEX IF NOT EXISTS ix_conflicts_open ON conflict_snapshots(tenant_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_devices_push ON devices(tenant_id, user_id) WHERE push_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_tenant_login_lower ON users(tenant_id, lower(login));
