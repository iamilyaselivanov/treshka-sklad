"""Извлекает legacy Base64-фото из снимка в media storage, не удаляя оригинал."""
import base64
import hashlib
import json
import uuid
from app.db import pool
from app.storage import normalize_image, save_image


def extract(tenant_id: str, data_url: str) -> dict:
    raw = base64.b64decode(data_url.split(",", 1)[1])
    data, sha256 = normalize_image(raw)
    key, backend = save_image(tenant_id, data)
    media_id = uuid.uuid4()
    return {"id": media_id, "key": key, "backend": backend, "size": len(data), "sha256": sha256}


def main() -> None:
    pool.open(wait=True)
    with pool.connection() as conn:
        states = conn.execute("SELECT tenant_id,revision,schema_version,payload FROM warehouse_state").fetchall()
        for tenant_id, revision, schema_version, payload in states:
            changed = False
            media = []
            for item in payload.get("items", []):
                if isinstance(item.get("photo"), str) and item["photo"].startswith("data:image/") and not item.get("photoMedia"):
                    info = extract(str(tenant_id), item["photo"])
                    item["photoMedia"] = {"id": str(info["id"]), "byteSize": info["size"], "sha256": info["sha256"]}
                    media.append(info)
                    changed = True
            for doc in payload.get("docs", []):
                if isinstance(doc.get("applicationPhoto"), str) and doc["applicationPhoto"].startswith("data:image/") and not doc.get("applicationPhotoMedia"):
                    info = extract(str(tenant_id), doc["applicationPhoto"])
                    doc["applicationPhotoMedia"] = {"id": str(info["id"]), "byteSize": info["size"], "sha256": info["sha256"]}
                    media.append(info)
                    changed = True
            if not changed:
                continue
            canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            checksum = hashlib.sha256(canonical.encode()).hexdigest()
            new_revision = revision + 1
            with conn.transaction():
                for info in media:
                    conn.execute(
                        "INSERT INTO media_objects(id,tenant_id,storage_backend,object_key,content_type,byte_size,sha256) VALUES (%s,%s,%s,%s,'image/jpeg',%s,%s)",
                        (info["id"], tenant_id, info["backend"], info["key"], info["size"], info["sha256"]),
                    )
                conn.execute(
                    "UPDATE warehouse_state SET revision=%s,payload=%s,checksum=%s,updated_at=now() WHERE tenant_id=%s AND revision=%s",
                    (new_revision, canonical, checksum, tenant_id, revision),
                )
                conn.execute(
                    "INSERT INTO warehouse_state_revisions(tenant_id,revision,schema_version,payload,checksum) VALUES (%s,%s,%s,%s,%s)",
                    (tenant_id, new_revision, schema_version, canonical, checksum),
                )
            print(f"{tenant_id}: extracted {len(media)} photos, revision {new_revision}")
    pool.close()


if __name__ == "__main__":
    main()
