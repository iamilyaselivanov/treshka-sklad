# Android `/v1` server API contract

The native Android sync stack is an **optional client for a separate bearer-token
service**. That service is not implemented in this repository.

The deployed Next.js/Cloudflare application in this repository exposes cookie
authenticated `/api/*` routes and synchronizes the WebView through
`public/prototype-server.js`. Those routes are not wire-compatible with the
native `/v1/*` client below. Do not point `AndroidSync.login()` at the website
origin unless a compatible `/v1` service has been deployed there.

All `/v1` endpoints require HTTPS. Except for login, requests carry
`Authorization: Bearer <token>` and JSON requests use
`Content-Type: application/json`.

## Roles

Responses may identify the authenticated user as:

```json
{
  "user": {
    "id": "user-id",
    "role": "owner",
    "post": "ТЭЧ"
  }
}
```

Supported roles are `owner`, `admin`, `storekeeper`, and `worker`. A missing or
empty role makes login fail and causes a previously migrated session to remain
unprivileged. An unknown non-empty role is accepted with native `worker`
privileges, so a newly introduced server role cannot accidentally gain
administrative access.

## Endpoints

### `POST /v1/auth/login`

Request:

```json
{ "login": "login", "password": "permanent password" }
```

Success:

```json
{ "token": "opaque bearer token", "user": { "id": "user-id", "role": "admin", "post": "" } }
```

`token` is mandatory. `user.role` is mandatory.

### `GET /v1/auth/status`

Returns `{ "user": { ... } }`. Android refreshes this periodically and also
adopts a role returned by push/pull responses. `401` or `403` clears the cached
role. `404`/`405` means the optional refresh endpoint is unsupported; the last
confirmed role remains in effect.

### `POST /v1/users`

Creates an employee account. The request body is supplied by the owner/admin UI.
The service must enforce authorization independently; the Android UI is not a
security boundary.

### `POST /v1/sync/push`

Request:

```json
{
  "mutationId": "uuid",
  "deviceId": "uuid",
  "baseRevision": 42,
  "schemaVersion": 4,
  "payload": {}
}
```

Every outbox row is a complete warehouse snapshot. `mutationId` is an
idempotency key: retrying the same key must return the already assigned
revision without applying the snapshot twice. A successful response contains
`{ "revision": 43 }` and may include `user`.

If `baseRevision` is stale, return `409` without changing state. Android parks
that row as a conflict and never silently overwrites either copy.

### `GET /v1/sync/pull?afterRevision=<n>`

When unchanged:

```json
{ "unchanged": true, "revision": 43 }
```

When newer:

```json
{ "revision": 44, "payload": {}, "user": { "id": "user-id", "role": "worker", "post": "ТЭЧ" } }
```

Conflict recovery calls this endpoint with `afterRevision=0`; that response
must include the full authoritative `payload` and `revision`.

### `POST /v1/devices/register`

Request:

```json
{ "deviceId": "uuid", "pushToken": "fcm-token" }
```

Registers or replaces the device token for the authenticated user. A response
may include `{ "evictedOldest": true }` when an account device limit was
enforced.

### `POST /v1/media/images`

Accepts `multipart/form-data` with one JPEG field named `file` and returns JSON
describing the stored image. The bearer token is mandatory. The service must
enforce size and media-type limits.

## Revision invariants

- `baseRevision` is captured when the local snapshot enters the durable outbox
  and is never rewritten merely because a retry starts.
- The locally stored server revision is monotonic.
- Only one process-wide `ServerSyncManager` may send or pull at a time.
- Permanent `4xx` failures leave the FIFO send lane as visible conflicts;
  retryable failures use bounded exponential backoff.
- Pull never overwrites unresolved local work. Both versions remain available
  until an authorized user chooses a conflict resolution.
