from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import jwt
from argon2.exceptions import VerifyMismatchError
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from .config import settings
from .db import pool, hasher

bearer = HTTPBearer()


def issue_token(user: dict) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {"sub": str(user["id"]), "tenant": str(user["tenant_id"]), "role": user["role"], "login": user["login"], "exp": now + timedelta(days=30), "iat": now},
        settings.jwt_secret,
        algorithm="HS256",
    )


def authenticate(login: str, password: str) -> dict | None:
    with pool.connection() as conn:
        row = conn.execute(
            "SELECT id,tenant_id,login,password_hash,role,post_name,legacy_password_hash,legacy_salt FROM users WHERE lower(login)=lower(%s) AND active=true LIMIT 1",
            (login,),
        ).fetchone()
    if row is None:
        return None
    if row[3] == "!legacy!":
        candidate = hashlib.sha256(f"{row[7]}:{password}".encode()).hexdigest()
        if not row[6] or not hmac.compare_digest(candidate, row[6]):
            return None
        with pool.connection() as conn:
            conn.execute(
                "UPDATE users SET password_hash=%s,legacy_password_hash=NULL,legacy_salt=NULL WHERE id=%s",
                (hasher.hash(password), row[0]),
            )
            conn.commit()
    else:
        try:
            hasher.verify(row[3], password)
        except VerifyMismatchError:
            return None
    return {"id": row[0], "tenant_id": row[1], "login": row[2], "role": row[4], "post": row[5]}


def current_user(credentials: HTTPAuthorizationCredentials = Depends(bearer)) -> dict:
    try:
        claims = jwt.decode(credentials.credentials, settings.jwt_secret, algorithms=["HS256"])
        with pool.connection() as conn:
            row = conn.execute(
                "SELECT login,role,post_name FROM users WHERE id=%s AND tenant_id=%s AND active=true",
                (claims["sub"], claims["tenant"]),
            ).fetchone()
        if row is None:
            raise HTTPException(status_code=401, detail="Аккаунт отключён или удалён")
        claims["login"], claims["role"], claims["post"] = row
        return claims
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="Недействительный токен") from exc
