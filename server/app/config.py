from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str
    jwt_secret: str
    bootstrap_admin_login: str = "admin"
    bootstrap_admin_password: str
    public_base_url: str
    media_root: Path = Path("/data/media")
    storage_backend: str = "local"
    s3_endpoint: str | None = None
    s3_bucket: str | None = None
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    fcm_credentials: Path | None = None
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
