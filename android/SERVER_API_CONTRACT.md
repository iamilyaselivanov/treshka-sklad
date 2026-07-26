# Android server API contract

The native Android synchronization client treats the server role as an
authorization boundary for conflict resolution and private-backup export.

Required endpoints:

- `POST /v1/auth/login` returns `{ "token": "...", "user": { "role": "..." } }`.
  `user.role` is mandatory and must be one of `owner`, `admin`, `storekeeper`,
  or `worker`. Android rejects a successful-looking login without this field.
- `GET /v1/auth/status` accepts the bearer token and returns
  `{ "user": { "role": "..." } }`. Android refreshes this periodically so a
  promotion or demotion takes effect without another login.
- Authenticated `/v1/sync/push` and `/v1/sync/pull` responses may include the
  same `user.role`; Android adopts it immediately when present.

During migration from an APK that did not store `server_role`, the token is
preserved but the role is intentionally unknown. The application denies native
administrative actions and shows an explicit prompt to sign in again until the
role is confirmed.
