"""Безопасный перенос локальных фото в S3 с возможностью повторного запуска."""
import hashlib
from pathlib import Path
import boto3
from app.config import settings
from app.db import pool


def main() -> None:
    if not all((settings.s3_endpoint, settings.s3_bucket, settings.s3_access_key, settings.s3_secret_key)):
        raise SystemExit("Заполните S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY")
    client = boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
    )
    pool.open(wait=True)
    with pool.connection() as conn:
        rows = conn.execute(
            "SELECT id,object_key,sha256 FROM media_objects WHERE storage_backend='local' ORDER BY created_at"
        ).fetchall()
        for media_id, key, expected_hash in rows:
            path = settings.media_root / key
            if not path.exists():
                print(f"SKIP missing {path}")
                continue
            data = path.read_bytes()
            if hashlib.sha256(data).hexdigest() != expected_hash:
                print(f"SKIP checksum mismatch {path}")
                continue
            client.put_object(Bucket=settings.s3_bucket, Key=key, Body=data, ContentType="image/jpeg")
            remote = client.get_object(Bucket=settings.s3_bucket, Key=key)["Body"].read()
            if hashlib.sha256(remote).hexdigest() != expected_hash:
                raise RuntimeError(f"S3 verification failed: {key}")
            with conn.transaction():
                conn.execute(
                    "UPDATE media_objects SET storage_backend='s3' WHERE id=%s AND storage_backend='local'",
                    (media_id,),
                )
            path.unlink()
            print(f"OK {key}")
    pool.close()


if __name__ == "__main__":
    main()
