# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the
major version is `0`, the wire contract — the `POST /v1/publish` request and response,
the HMAC signature scheme, the outgoing webhook headers, the required environment
variables and the queue topology — may still change in a minor release. Every such
change is listed here with the steps an existing deployment has to take.

## [Unreleased]

### Added

- Documentation on connection-pool sizing for Prisma and PostgreSQL when scaling worker replicas (`docs/connection-pool-sizing.md`).
- `DATABASE_POOL_SIZE` configuration variable (default `10`) in `backend/src/shared/env-schema.js`, `.env.example`, and wired to `@prisma/adapter-pg` in `backend/src/shared/db.js`.

### Changed

- Publish rate limiting now enforces separate per-key and per-project ceilings. Existing deployments should set `RATE_LIMIT_PUBLISH_PROJECT_PER_MINUTE` to an aggregate project budget greater than or equal to `RATE_LIMIT_PUBLISH_PER_MINUTE`; the default is `6000`. Rate-limit problem details now name the counter that refused the request.

## [0.3.0] - 2026-09-03

An audit of the whole repository — the API surface, the operational topology, the dashboard, the
specifications, the test suite, and then a separate pass reading the code for security and
correctness. What it found that was a defect is fixed here. What it found that was missing is
written down in [`docs/roadmap.md`](docs/roadmap.md) rather than left to be discovered.

### Security

- **An endpoint's URL could be changed by any project member.** `update`, `enable` and `disable`
  answered to `MEMBER`, while `docs/architecture.md` grants a member read access plus replay. A
  member could point an endpoint at a server they controlled and receive every payload the project
  published to it. The service now requires `OWNER` by default, and only the operations that are
  genuinely a member's — sending a test event — opt out of it.
- **The SSRF guard could be bypassed with an IPv6 literal.** `classifyIpv6` matched IPv4-mapped
  addresses only in dotted form, and `URL` normalises them to hex, so `http://[::ffff:127.0.0.1]/`
  and `http://[::ffff:a9fe:a9fe]/` — the cloud metadata address — were classified as public and
  delivered to, with the response body readable through the delivery detail. Classification now
  works on the 16 bytes of the address and covers IPv4-mapped, IPv4-compatible and NAT64 forms, and
  the IPv4 table gained the special-use blocks it was missing.
- **One account's failed logins locked out everyone else.** The auth limit was counted per address,
  and behind the dashboard's nginx every login arrives from the proxy. It is now counted per address
  and account together. `TRUST_PROXY` (default 0) says how many proxies sit in front of the API.
- **Refresh rotation was not atomic and reuse was not detected.** Two concurrent refreshes with one
  stolen cookie could both succeed. Rotation is now a conditional update, and a token that comes
  back after it was rotated revokes the whole family and is logged.
- **`GET /ready` returned the client library's error text**, which carries internal hosts and ports,
  to an unauthenticated caller. The body now names the dependency and whether it is up; the reason
  goes to the log.

### Fixed

- **A resolver outage failed deliveries permanently.** Every failure from the SSRF guard was treated
  as permanent, so a name that did not resolve skipped the retry ladder, landed in the dead-letter
  queue and counted against the endpoint's health. `dns_failure` is retryable now, as
  `docs/architecture.md` §5 always said it was; a blocked scheme, port, URL or private address stays
  permanent.
- **The consecutive-failure counter lost increments under load.** It was written from the value read
  at the start of the attempt, so concurrent failures overwrote each other and
  `ENDPOINT_AUTO_DISABLE_THRESHOLD` was effectively unreachable while a worker was busy. The
  increment happens in the database now, and crossing the threshold is a separate conditional update
  so the disable, its event and its alert happen exactly once.
- **The default idempotency key ignored `endpointIds`.** The same body aimed at a second endpoint
  replayed the first response and produced no deliveries at all. The key now covers the target set,
  order-insensitively; a publish that names no endpoints hashes exactly as before, so keys already
  issued stay valid.
- **Replaying a delivery that had not finished queued a duplicate.** Single replay now refuses
  `PENDING` and `IN_FLIGHT` with `409`, matching what bulk replay already skipped.
- **A long `JWT_ACCESS_TTL` killed the realtime socket.** Anything past about 24.8 days overflowed
  the expiry timer and fired it immediately, so every socket disconnected as soon as it connected.
- **Signing in with no project left the user on a dead end.** The login form now lands on project
  creation, which is where the router guard already sent anyone who reloaded the page.

### Added

- [`docs/roadmap.md`](docs/roadmap.md) — 38 items that are not built, each with why it matters and
  how big it is, and a list of what is deliberately out of scope. The README links to it.
- `TRUST_PROXY`, documented with the reason it is off by default.

### Changed

- Editing, enabling and disabling an endpoint are owner-only, in the API and in the dashboard.
  Sending a test event stays open to a member.
- The specifications were corrected where they had drifted from the code: the registration model on
  the login screen, the `delivery.failed` reason vocabulary, the level the HMAC test actually runs
  at, and the implementation plan's status line.

## [0.2.0] - 2026-09-02

Visibility and alerting: the dead-letter queue stops growing, a project can be told when something
breaks, and events are queryable by what they carry.

### Added

- An events endpoint and payload search. `GET /v1/projects/:projectId/events` lists what a project
  received, keyset paginated, with `payloadPath` and `payloadValue` finding an event by a value
  inside its payload — exact containment at a path, served by a GIN index. `GET /v1/events/:eventId`
  returns the payload and the deliveries the event produced. The events screen reads these instead
  of grouping the delivery rows it had loaded.
- Per-project alerting. A project can set `alertWebhookUrl` in its settings and is told when an
  endpoint is auto-disabled, when the dead-letter queue crosses `ALERT_DLQ_THRESHOLD`, and when
  Redis or RabbitMQ becomes unreachable. Alerts are unsigned, never retried, suppressed to one per
  `ALERT_SUPPRESSION_MINUTES` for the same reason and scope, and carry no payload, secret or API
  key. The address is guarded by the SSRF check that guards endpoint URLs.
- Dead-letter messages now expire. `publishDeadLetter` stamps every message with
  `DLQ_MESSAGE_TTL_HOURS` (default 24), so `webhook.dlq` no longer grows without a bound. Replay is
  unaffected: it reads the `Delivery` row in Postgres, which the queue only ever duplicated.

### Upgrading

- Two additive migrations: `projects.alertWebhookUrl` and a GIN index on
  `webhook_events.payload`. `prisma migrate deploy` applies both. The column is nullable and
  nothing behaves differently until an address is set; the index build takes a lock proportional
  to the table, and `CREATE INDEX CONCURRENTLY` is the manual alternative where that matters.
- Messages already sitting in `webhook.dlq` were published without an expiry and will stay there.
  Purge them once, by hand, after deploying this version. No topology change is required — the
  expiry travels on the message, not on the queue.

## [0.1.0] - 2026-09-02

First release. A webhook gateway and retry engine that takes one event from your
backend and becomes responsible for delivering it to every endpoint that wants it.
`docker compose up` brings up the whole stack: Postgres, Redis, RabbitMQ, the API, the
delivery workers, the maintenance jobs, the dashboard, and a demo receiver.

### Added

**Ingestion**

- `POST /v1/publish` — API key authentication, zod-validated payloads, fan-out to every
  matching `ACTIVE` endpoint or to an explicit `endpointIds` list, answering `202` with
  the event id and the deliveries it created.
- Idempotency on an `Idempotency-Key` header, defaulting to
  `sha256(eventType + canonicalJson(payload))` when the header is absent. A repeat
  within `IDEMPOTENCY_TTL_SECONDS` returns the original response with
  `Idempotency-Replayed: true`; a concurrent duplicate is refused with `409`.
- Per-key sliding-window rate limiting in Redis, with `RateLimit-Limit`,
  `RateLimit-Remaining` and `RateLimit-Reset` on every publish response.
- RFC 9457 `application/problem+json` errors throughout, each carrying the `requestId`
  that also appears in the logs.

**Delivery and retries**

- TTL + DLX retry ladder on RabbitMQ — 1m, 5m, 30m, 2h, 6h, at most six attempts —
  built from queue arguments alone, with no broker plugins.
- Every attempt is a row: request headers, response status, body excerpt, duration and
  error, kept for the life of the event.
- Per-endpoint token-bucket rate limiting, consecutive-failure counting and automatic
  disable, plus manual enable, disable and rotate-secret with a grace window.
- Manual replay of a single delivery and bulk replay of a filtered set, each producing a
  new delivery that records what it was replayed from.
- Maintenance jobs: retention deletes events past `RETENTION_DAYS` in bounded batches,
  and a sweeper returns deliveries stuck `IN_FLIGHT` past `STUCK_DELIVERY_MINUTES` to
  `RETRYING` and republishes them.

**Security**

- HMAC-SHA256 request signing with a per-endpoint secret, encrypted at rest with
  AES-256-GCM, and an overlap window so a rotated secret does not drop in-flight
  deliveries.
- SSRF guard on every endpoint URL — DNS resolution, private-range rejection and IP
  pinning that keeps SNI and certificate validation intact — run when a URL is saved as
  well as at delivery time.
- API keys stored hashed and shown in full exactly once; argon2id passwords; refresh
  tokens stored hashed and rotated on use; membership read from the database on every
  request so removing someone takes effect immediately.
- Secrets, API keys and `Authorization` headers removed from logs through a pino
  redaction path list.

**Dashboard**

- Vue 3 dashboard served by nginx: deliveries with URL-persisted filters, delivery
  detail with the attempt timeline and copy-as-cURL, endpoints, events and project
  settings.
- Live updates over Socket.io — rows patch in place as attempts land, without a manual
  refresh.
- Light and dark themes, following the system preference until the header toggle
  overrides it.

**Operations**

- `GET /health` and `GET /ready`, the latter checking Postgres, Redis and RabbitMQ.
- `GET /docs` and `GET /openapi.json`, generated from the same zod schemas the routes
  validate with.
- `GET /metrics` in Prometheus exposition format, deliberately low-cardinality: no
  project id, endpoint id or URL appears in any label. Per-project figures come from
  `GET /v1/projects/:projectId/stats`.
- Structured JSON logs carrying `requestId` on the API and `deliveryId` with `attempt`
  on the worker.

**Documentation**

- `docs/receiving-webhooks.md` for the team on the other end: signature verification,
  timestamp tolerance, deduplication on `X-Webhook-Id`, which status code to answer
  with, and working Node.js and Python receivers.
- Architecture, API contract, dashboard and code-review specifications under `docs/`.

### Known limitations

- `SECRET_ENCRYPTION_KEY` cannot be rotated without re-encrypting every stored endpoint
  secret; that migration is out of scope for this release.
- The dashboard offers Register unconditionally, because no route reports whether an
  instance already has a user.
- The events screen groups the delivery rows it has loaded rather than reading a
  complete event log, because the API has no event endpoint.
- There is no CI pipeline. Lint, both test suites, `prisma validate` and the Docker
  build are run locally and their output observed, as `docs/guidelines.md` requires.

[Unreleased]: https://github.com/sametozeren/hook-tracker/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/sametozeren/hook-tracker/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sametozeren/hook-tracker/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sametozeren/hook-tracker/releases/tag/v0.1.0
