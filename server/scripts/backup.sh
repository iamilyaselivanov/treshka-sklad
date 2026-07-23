#!/bin/sh
set -eu
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="/backups/$stamp"
mkdir -p "$target"
pg_dump "$DATABASE_URL" --format=custom --file="$target/postgres.dump"
tar -C "$MEDIA_ROOT" -czf "$target/media.tar.gz" .
sha256sum "$target/postgres.dump" "$target/media.tar.gz" > "$target/SHA256SUMS"
find /backups -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} \;
echo "$target"
