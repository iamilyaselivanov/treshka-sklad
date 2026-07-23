import hashlib
import io
import uuid
from pathlib import Path
import boto3
from PIL import Image, ImageOps
from .config import settings


def normalize_image(raw: bytes) -> tuple[bytes, str]:
    with Image.open(io.BytesIO(raw)) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
        image.thumbnail((1280, 1280), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        image.save(output, "JPEG", quality=78, optimize=True, progressive=True)
        data = output.getvalue()
    if len(data) > 1_000_000:
        raise ValueError("Фотография после сжатия превышает 1 МБ")
    return data, hashlib.sha256(data).hexdigest()


def save_image(tenant_id: str, data: bytes) -> tuple[str, str]:
    key = f"{tenant_id}/photos/{uuid.uuid4()}.jpg"
    if settings.storage_backend == "s3":
        client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint,
            aws_access_key_id=settings.s3_access_key,
            aws_secret_access_key=settings.s3_secret_key,
        )
        client.put_object(Bucket=settings.s3_bucket, Key=key, Body=data, ContentType="image/jpeg")
        return key, "s3"
    path = settings.media_root / key
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_bytes(data)
    temp.replace(path)
    return key, "local"
