import hashlib
import json
import uuid
from contextlib import asynccontextmanager
from fastapi import BackgroundTasks, Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, Field
from .auth import authenticate, current_user, issue_token
from .config import settings
from .db import migrate, pool
from .push import dispatch_pending
from .storage import normalize_image, save_image


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings.media_root.mkdir(parents=True, exist_ok=True)
    migrate()
    yield
    pool.close()


app = FastAPI(title="ТРЁШКА склад API", version="1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class LoginRequest(BaseModel):
    login: str
    password: str


class SyncPush(BaseModel):
    mutationId: uuid.UUID
    deviceId: str = Field(min_length=8, max_length=100)
    baseRevision: int = Field(ge=0)
    schemaVersion: int = Field(ge=1)
    payload: dict


class DeviceRegistration(BaseModel):
    deviceId: str
    pushToken: str


class UserCreate(BaseModel):
    login: str = Field(pattern=r"^[A-Za-zА-Яа-яЁё0-9._-]{3,40}$")
    password: str = Field(min_length=6, max_length=200)
    role: str
    post: str | None = None


class ConflictResolution(BaseModel):
    decision: str = Field(pattern=r"^(server|local)$")


@app.get("/health")
def health():
    with pool.connection() as conn:
        conn.execute("SELECT 1")
    return {"ok": True}


@app.post("/v1/auth/login")
def login(request: LoginRequest):
    user = authenticate(request.login, request.password)
    if user is None:
        raise HTTPException(status_code=401, detail="Неверный логин или пароль")
    return {"token": issue_token(user), "user": {"login": user["login"], "role": user["role"], "post": user["post"]}}


@app.post("/v1/devices/register")
def register_device(request: DeviceRegistration, user=Depends(current_user)):
    with pool.connection() as conn:
        conn.execute(
            """
            INSERT INTO devices(tenant_id,user_id,device_key,push_token)
            VALUES (%s,%s,%s,%s)
            ON CONFLICT(tenant_id,device_key) DO UPDATE SET user_id=excluded.user_id,push_token=excluded.push_token,updated_at=now()
            """,
            (user["tenant"], user["sub"], request.deviceId, request.pushToken),
        )
        conn.commit()
    return {"ok": True}


@app.get("/v1/users")
def list_users(user=Depends(current_user)):
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Только администратор")
    with pool.connection() as conn:
        rows = conn.execute(
            "SELECT id,login,role,post_name,active,created_at FROM users WHERE tenant_id=%s ORDER BY login",
            (user["tenant"],),
        ).fetchall()
    return [{"id": str(r[0]), "login": r[1], "role": r[2], "post": r[3], "active": r[4], "createdAt": r[5]} for r in rows]


@app.post("/v1/users")
def create_user(request: UserCreate, user=Depends(current_user)):
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Только администратор")
    if request.role not in {"admin", "kladovshik", "rabotnik"}:
        raise HTTPException(status_code=422, detail="Некорректная роль")
    if request.role == "rabotnik" and not request.post:
        raise HTTPException(status_code=422, detail="Работнику требуется пост")
    from .db import hasher
    try:
        with pool.connection() as conn:
            row = conn.execute(
                "INSERT INTO users(tenant_id,login,password_hash,role,post_name) VALUES (%s,%s,%s,%s,%s) RETURNING id",
                (user["tenant"], request.login, hasher.hash(request.password), request.role, request.post),
            ).fetchone()
            conn.commit()
    except Exception as exc:
        raise HTTPException(status_code=409, detail="Логин уже существует") from exc
    return {"id": str(row[0]), "login": request.login, "role": request.role, "post": request.post}


@app.post("/v1/sync/push")
def sync_push(request: SyncPush, background: BackgroundTasks, user=Depends(current_user)):
    tenant = user["tenant"]
    canonical = json.dumps(request.payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    checksum = hashlib.sha256(canonical.encode()).hexdigest()
    conflict = None
    with pool.connection() as conn, conn.transaction():
        applied = conn.execute(
            "SELECT applied_revision FROM sync_mutations WHERE tenant_id=%s AND mutation_id=%s",
            (tenant, request.mutationId),
        ).fetchone()
        if applied:
            return {"revision": applied[0], "idempotent": True}
        state = conn.execute(
            "SELECT revision FROM warehouse_state WHERE tenant_id=%s FOR UPDATE",
            (tenant,),
        ).fetchone()
        current_revision = state[0] if state else 0
        if request.baseRevision != current_revision:
            conn.execute(
                """
                INSERT INTO conflict_snapshots(tenant_id,mutation_id,device_id,base_revision,server_revision,schema_version,payload)
                VALUES (%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT DO NOTHING
                """,
                (tenant, request.mutationId, request.deviceId, request.baseRevision, current_revision, request.schemaVersion, json.dumps(request.payload)),
            )
            conflict = {"detail": "revision_conflict", "serverRevision": current_revision, "localSnapshotPreserved": True}
        else:
            next_revision = current_revision + 1
            conn.execute(
                """
                INSERT INTO warehouse_state(tenant_id,revision,schema_version,payload,checksum)
                VALUES (%s,%s,%s,%s,%s)
                ON CONFLICT(tenant_id) DO UPDATE SET revision=excluded.revision,schema_version=excluded.schema_version,
                  payload=excluded.payload,checksum=excluded.checksum,updated_at=now()
                """,
                (tenant, next_revision, request.schemaVersion, canonical, checksum),
            )
            conn.execute(
                "INSERT INTO warehouse_state_revisions(tenant_id,revision,schema_version,payload,checksum) VALUES (%s,%s,%s,%s,%s)",
                (tenant, next_revision, request.schemaVersion, canonical, checksum),
            )
            conn.execute(
                "INSERT INTO sync_mutations VALUES (%s,%s,%s,%s,%s,%s,now())",
                (tenant, request.mutationId, request.deviceId, request.baseRevision, next_revision, checksum),
            )
            for n in request.payload.get("notifications", []):
                conn.execute(
                    """
                    INSERT INTO push_events(tenant_id,event_id,title,body,recipient_login,recipient_role,post_name)
                    VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING
                    """,
                    (tenant, str(n.get("id")), n.get("title", "Склад"), n.get("body", ""), n.get("recipientLogin"), n.get("recipientRole"), n.get("post")),
                )
            # Бесшовный перенос уже созданных локальных аккаунтов. Старый
            # SHA-256+salt допускается только до первого успешного входа, после
            # чего пароль автоматически перехэшируется Argon2id.
            for account in request.payload.get("accounts", []):
                if not account.get("login") or not account.get("passwordHash") or not account.get("salt"):
                    continue
                legacy_role = account.get("role", "rabotnik")
                if legacy_role not in {"admin", "kladovshik", "rabotnik"}:
                    continue
                conn.execute(
                    """
                    INSERT INTO users(tenant_id,login,password_hash,legacy_password_hash,legacy_salt,role,post_name,active)
                    VALUES (%s,%s,'!legacy!',%s,%s,%s,%s,%s)
                    ON CONFLICT(tenant_id,login) DO NOTHING
                    """,
                    (tenant, account["login"], account["passwordHash"], account["salt"], legacy_role, account.get("post"), account.get("active", True)),
                )
    if conflict:
        return JSONResponse(conflict, status_code=409)
    background.add_task(dispatch_pending, tenant)
    return {"revision": next_revision}


@app.get("/v1/sync/conflicts")
def list_conflicts(user=Depends(current_user)):
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Только администратор")
    with pool.connection() as conn:
        rows = conn.execute(
            """
            SELECT id,mutation_id,device_id,base_revision,server_revision,schema_version,created_at
            FROM conflict_snapshots WHERE tenant_id=%s AND resolved_at IS NULL ORDER BY created_at
            """,
            (user["tenant"],),
        ).fetchall()
    return [{"id": r[0], "mutationId": str(r[1]), "deviceId": r[2], "baseRevision": r[3], "serverRevision": r[4], "schemaVersion": r[5], "createdAt": r[6]} for r in rows]


@app.post("/v1/sync/conflicts/{conflict_id}/resolve")
def resolve_conflict(conflict_id: int, request: ConflictResolution, user=Depends(current_user)):
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Только администратор")
    tenant = user["tenant"]
    with pool.connection() as conn, conn.transaction():
        conflict = conn.execute(
            """
            SELECT mutation_id,device_id,base_revision,schema_version,payload
            FROM conflict_snapshots WHERE id=%s AND tenant_id=%s AND resolved_at IS NULL FOR UPDATE
            """,
            (conflict_id, tenant),
        ).fetchone()
        if conflict is None:
            raise HTTPException(status_code=404, detail="Конфликт не найден или уже решён")
        state = conn.execute("SELECT revision FROM warehouse_state WHERE tenant_id=%s FOR UPDATE", (tenant,)).fetchone()
        current_revision = state[0] if state else 0
        if request.decision == "local":
            canonical = json.dumps(conflict[4], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            checksum = hashlib.sha256(canonical.encode()).hexdigest()
            applied_revision = current_revision + 1
            conn.execute(
                """
                INSERT INTO warehouse_state(tenant_id,revision,schema_version,payload,checksum)
                VALUES (%s,%s,%s,%s,%s)
                ON CONFLICT(tenant_id) DO UPDATE SET revision=excluded.revision,schema_version=excluded.schema_version,
                  payload=excluded.payload,checksum=excluded.checksum,updated_at=now()
                """,
                (tenant, applied_revision, conflict[3], canonical, checksum),
            )
            conn.execute(
                "INSERT INTO warehouse_state_revisions(tenant_id,revision,schema_version,payload,checksum) VALUES (%s,%s,%s,%s,%s)",
                (tenant, applied_revision, conflict[3], canonical, checksum),
            )
        else:
            applied_revision = current_revision
            checksum = hashlib.sha256(json.dumps(conflict[4], ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        conn.execute(
            """
            INSERT INTO sync_mutations(tenant_id,mutation_id,device_id,base_revision,applied_revision,payload_checksum)
            VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING
            """,
            (tenant, conflict[0], conflict[1], conflict[2], applied_revision, checksum),
        )
        conn.execute("UPDATE conflict_snapshots SET resolved_at=now() WHERE id=%s", (conflict_id,))
    return {"resolved": True, "decision": request.decision, "revision": applied_revision}


@app.get("/v1/sync/pull")
def sync_pull(afterRevision: int = 0, user=Depends(current_user)):
    with pool.connection() as conn:
        row = conn.execute(
            "SELECT revision,schema_version,payload FROM warehouse_state WHERE tenant_id=%s",
            (user["tenant"],),
        ).fetchone()
    if row is None or row[0] <= afterRevision:
        return {"unchanged": True, "revision": row[0] if row else 0}
    return {"unchanged": False, "revision": row[0], "schemaVersion": row[1], "payload": row[2]}


@app.post("/v1/media/images")
async def upload_image(file: UploadFile = File(...), user=Depends(current_user)):
    if file.content_type not in {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}:
        raise HTTPException(status_code=415, detail="Поддерживаются только изображения")
    raw = await file.read(15_000_001)
    if len(raw) > 15_000_000:
        raise HTTPException(status_code=413, detail="Исходный файл превышает 15 МБ")
    try:
        data, sha256 = normalize_image(raw)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    key, backend = save_image(user["tenant"], data)
    media_id = uuid.uuid4()
    with pool.connection() as conn:
        conn.execute(
            "INSERT INTO media_objects(id,tenant_id,storage_backend,object_key,content_type,byte_size,sha256) VALUES (%s,%s,%s,%s,'image/jpeg',%s,%s)",
            (media_id, user["tenant"], backend, key, len(data), sha256),
        )
        conn.commit()
    return {"id": str(media_id), "byteSize": len(data), "sha256": sha256, "url": f"{settings.public_base_url}/v1/media/{media_id}"}


@app.get("/v1/media/{media_id}")
def get_media(media_id: uuid.UUID, user=Depends(current_user)):
    with pool.connection() as conn:
        row = conn.execute(
            "SELECT storage_backend,object_key,content_type FROM media_objects WHERE id=%s AND tenant_id=%s",
            (media_id, user["tenant"]),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Файл не найден")
    if row[0] == "s3":
        import boto3
        client = boto3.client("s3", endpoint_url=settings.s3_endpoint, aws_access_key_id=settings.s3_access_key, aws_secret_access_key=settings.s3_secret_key)
        url = client.generate_presigned_url("get_object", Params={"Bucket": settings.s3_bucket, "Key": row[1]}, ExpiresIn=300)
        return RedirectResponse(url)
    path = settings.media_root / row[1]
    if not path.exists():
        raise HTTPException(status_code=404, detail="Файл отсутствует в хранилище")
    return FileResponse(path, media_type=row[2], headers={"Cache-Control": "private, max-age=300"})
