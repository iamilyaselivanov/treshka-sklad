from pathlib import Path
from psycopg_pool import ConnectionPool
from argon2 import PasswordHasher
from .config import settings

pool = ConnectionPool(settings.database_url, min_size=1, max_size=8, open=False)
hasher = PasswordHasher()


def migrate() -> None:
    pool.open(wait=True)
    migrations = sorted((Path(__file__).parent.parent / "migrations").glob("*.sql"))
    with pool.connection() as conn, conn.transaction():
        conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
        applied = {r[0] for r in conn.execute("SELECT version FROM schema_migrations")}
        for path in migrations:
            if path.name in applied:
                continue
            conn.execute(path.read_text(encoding="utf-8"))
            conn.execute("INSERT INTO schema_migrations(version) VALUES (%s)", (path.name,))
        tenant = conn.execute("SELECT id FROM tenants ORDER BY created_at LIMIT 1").fetchone()
        if tenant is None:
            tenant = conn.execute("INSERT INTO tenants(name) VALUES ('ТРЁШКА склад') RETURNING id").fetchone()
        exists = conn.execute("SELECT 1 FROM users WHERE tenant_id=%s AND login=%s", (tenant[0], settings.bootstrap_admin_login)).fetchone()
        if exists is None:
            conn.execute(
                "INSERT INTO users(tenant_id,login,password_hash,role) VALUES (%s,%s,%s,'admin')",
                (tenant[0], settings.bootstrap_admin_login, hasher.hash(settings.bootstrap_admin_password)),
            )
