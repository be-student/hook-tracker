# Implementation Plan

**Status:** Phases 0-8 complete and released as `v0.2.0`, every acceptance check run and observed. Last updated 2026-09-03.

Ordered phases. Each one ends in something that runs and can be checked, so a broken phase is caught before the next depends on it. Do not start a phase until its predecessor's acceptance check passes. Update the status line above when a phase closes, so a session that starts with no memory of this one knows where the work stands.

This file carries order, completion state and risk. What each piece does belongs in `architecture.md`, `api.md`, `dashboard.md` and `guidelines.md` — restating that here would create a second copy to keep in sync.

## Definition of Done

Applies to every phase, in addition to its own acceptance check:

- [ ] Lint and format clean in both packages
- [ ] New behavior covered by a test at the right level — unit for pure logic, integration for anything touching Postgres, Redis or RabbitMQ
- [ ] `.env.example` covers every new variable, with a safe default or an explicitly invalid placeholder
- [ ] No secret, token, endpoint URL or payload added to a log line
- [ ] If implementation changed a decision, the affected spec document is updated in the same change — and the Turkish reading page is flagged for update
- [ ] The acceptance check was actually run and its output observed, not assumed

## Known Risks

Places where the work is likely to stall. Listed here rather than in the specs because they concern building, not behavior.

| Risk                                                                                         | Phase | Handling                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prisma client generation and import paths under ESM need extra configuration                 | 1     | Resolved: the v7 `prisma-client` generator emits TypeScript into `src/generated/prisma`, which Node 24 runs directly through type stripping, and v7 requires a driver adapter (`@prisma/adapter-pg`). Both are contained in `shared/db.js`, the only module that imports the generated client. A Node older than 24 cannot run the client without `--experimental-strip-types`, which is why `engines` pins 24 |
| RabbitMQ queue arguments are immutable — a wrong TTL yields `PRECONDITION_FAILED` on restart | 2     | Resolved: `npm run queue:reset` inspects every queue first and refuses to delete one that still holds messages unless `--force` is passed; it also refuses to run with `NODE_ENV=production`. The broker is not published to the host, so it is used as `docker compose run --rm api npm run queue:reset`                                                                                                      |
| Testcontainers on Windows and Docker Desktop: slow starts, socket path configuration         | 2     | Resolved: `tests/integration/docker-environment.test.js` starts a bare alpine container, so an environment fault is told apart from a code fault at a glance. One broker is started per test file and stopped in `afterAll`; container reuse is not enabled while a single file needs a broker, and is the next step if that changes                                                                           |
| Connecting to a pinned IP while keeping TLS valid                                            | 4     | Resolved: a fresh `undici` Agent per attempt whose `connect.lookup` returns the verified address. The request is still made against the original URL, so SNI and the `Host` header carry the hostname and certificate validation is unaffected. One agent per attempt rather than a pooled one, because a pinned address belongs to a single attempt                                                           |
| Socket.io fan-out across replicas only misbehaves with more than one API instance            | 5     | Resolved: the worker's pub/sub message reaches every API instance, so each one emits to its **local** sockets and the adapter is not used for that path — emitting through it would send one copy per replica. An integration test runs a second API instance against the same Redis and asserts a client connected to it receives exactly one copy                                                            |
| Refresh cookie behind the Vite dev server behaves differently than behind nginx              | 6     | Dev server proxies `/v1` to the API so the cookie stays same-origin; cookie `Path` and CORS credentials verified in both setups                                                                                                                                                                                                                                                                                |
| A per-project alert URL is user input, so it can point at the internal network               | 8     | It goes through `resolveSafeTarget`, the same guard endpoint URLs use, when it is saved. The dispatcher never follows it without that check, and the failure surfaces on the settings form rather than at send time                                                                                                                                                                                            |
| Payload search can outgrow its index and turn the events list into a sequential scan         | 8     | Search is exact containment on a caller-supplied path and value, served by a GIN index on `payload`. Free-text substring search is deliberately out of scope: it needs a trigram index over the whole document, whose write cost lands on the ingestion path                                                                                                                                                   |
| An alert storm can bury the signal it is meant to raise                                      | 8     | A Redis suppression window per alert source, `ALERT_SUPPRESSION_MINUTES`. A channel that reports the same endpoint every minute gets muted by its reader, which is the same as having no alerting                                                                                                                                                                                                              |

## Phase 0 — Repository skeleton

- [x] `README.md`, `LICENSE` (MIT), `.gitignore`, `.dockerignore`, `.editorconfig`, `.nvmrc` (Node 24)
- [x] `.env.example` covering every key in the configuration reference
- [x] `backend/package.json` (`"type": "module"`, `engines`, scripts: `start:api`, `start:worker`, `start:jobs`, `start:receiver`, `lint`, `test`, `test:integration`, `seed`)
- [x] `dashboard/package.json` (Vue 3, Vite, Tailwind)
- [x] `backend/Dockerfile`, `dashboard/Dockerfile` + `dashboard/nginx.conf`
- [x] `docker-compose.yml` with healthchecks, the one-shot `migrate` service, and the dependency conditions from architecture §2.1
- [x] `backend/src/shared/config.js` — zod env schema, cross-field rules (MAX_ATTEMPTS vs schedule, production secret checks), exits on invalid input
- [x] `backend/src/shared/logger.js` — pino with the redaction path list
- [x] ESLint + Prettier config in both packages

**Acceptance:** `docker compose up` starts postgres, redis, rabbitmq and api; `GET /health` returns 200; a missing required env var stops the process with a readable message.

## Phase 1 — Data layer

- [x] `backend/prisma/schema.prisma` — every model, enum, index and cascade rule from architecture §11
- [x] Initial migration committed
- [x] `backend/src/shared/ids.js` — prefixed cuid2 helper
- [x] `backend/src/shared/crypto.js` — argon2id hashing, AES-256-GCM secret encryption, constant-time compare
- [x] `backend/prisma/seed.js` — demo user, project, API key, endpoint pointing at the receiver
- [x] `backend/src/demo-receiver/server.js` — the routes from architecture §2.2
- [x] `backend/src/shared/db.js` — driver adapter, the single import site of the generated client
- [x] `backend/src/shared/hmac.js` — pulled forward from phase 4, because the receiver verifies signatures and the signing function may exist only once
- [x] `receiver` service in `docker-compose.yml`, without a host port

**Acceptance:** `migrate deploy` runs clean on an empty database; `npm run seed` produces the demo records; the receiver answers each of its routes as specified.

## Phase 2 — Queue layer

- [x] `backend/src/shared/queue/topology.js` — single declaration of exchanges, queues, TTLs, DLX bindings
- [x] `backend/src/shared/queue/connection.js` — connect with retry, channel management, graceful close
- [x] `backend/src/shared/queue/publisher.js` — publish to main, retry level and DLQ
- [x] `backend/src/shared/retry.js` — schedule, level selection, jitter, failure classification
- [x] Integration test: a message published to `retry.1m` reappears on `webhook.delivery` after its TTL
- [x] `backend/scripts/queue-reset.js` and the `queue:reset` script, from the immutable-arguments risk below
- [x] `backend/vitest.config.js` — container-sized timeouts for the integration suite

**Acceptance:** topology asserts idempotently on a second startup; the ladder test passes against a real broker in Testcontainers.

## Phase 3 — Ingestion API

- [x] Express app, request id middleware, problem+json error middleware, `AppError` hierarchy, helmet, CORS from `CORS_ORIGINS`
- [x] API key authentication (prefix lookup, constant-time hash compare, `lastUsedAt`)
- [x] Redis sliding-window rate limiter per API key and project with the documented response headers
- [x] Idempotency middleware (reserve, store, replay, `409` on concurrent duplicates)
- [x] `POST /v1/publish` — validation, fan-out selection, event + delivery rows, publish
- [x] `/health`, `/ready`
- [x] `src/shared/redis.js`, `src/shared/json.js` (canonical serialisation) and `src/shared/event-types.js` (subscription matching)
- [x] Topology asserted at API startup, and the app assembled by `createApp({ ... })` so an integration test can drive it against containers

**Acceptance:** an integration test publishes an event, sees rows in Postgres and a message on the queue, gets the identical response on a repeat with the same `Idempotency-Key`, and is rate limited past the configured threshold.

## Phase 4 — Delivery worker

- [x] `backend/src/shared/hmac.js` — signing, including the rotation overlap (delivered in phase 1)
- [x] `backend/src/shared/ssrf.js` — DNS resolution, range checks, IP pinning, allowlist
- [x] HTTP client with split timeouts and no redirect following
- [x] Attempt handler: response capture, transactional attempt row + status update, then ack
- [x] Retry routing, DLQ routing, endpoint token-bucket parking
- [x] Consecutive failure counter and auto-disable
- [x] Realtime publishing to Redis pub/sub
- [x] Graceful shutdown
- [x] `backend/src/shared/token-bucket.js` — refill and take in one Redis round trip
- [x] `worker` service in `docker-compose.yml`, scalable through `deploy.replicas`

**Acceptance:** against the demo receiver, `/ok` succeeds on the first attempt, `/fail-500` walks the full ladder into the DLQ with six attempt rows, `/slow` times out and retries, a private-address endpoint is rejected by the SSRF guard, and a worker killed mid-delivery redelivers without losing the audit row.

## Phase 5 — Dashboard API and realtime

- [x] Auth routes: register, login, refresh rotation, logout, me
- [x] JWT middleware and membership-based authorization
- [x] Projects, members, API keys, endpoints (including rotate-secret, enable, disable, test)
- [x] Deliveries: keyset list with filters, detail with attempts, replay, bulk replay, stats
- [x] Socket.io namespace with handshake auth, project rooms, Redis adapter, per-project throttle, disconnect on access-token expiry
- [x] `RefreshToken` model and its migration — the one entity §11 did not carry, needed to store refresh tokens hashed and revoke them server-side
- [x] Per-IP rate limit on the auth routes

**Acceptance:** a member of one project cannot read another project's deliveries by id; a replay creates a new delivery with `replayedFromId` set; a connected client receives `delivery.succeeded` for its own project only.

## Phase 6 — Vue dashboard

- [x] Shell, router, auth store, API client with refresh handling
- [x] Login and register
- [x] Deliveries list with filters in the URL, status pills, live updates and the "N new" bar
- [x] Delivery detail with attempt timeline, payload viewer, replay and copy-as-cURL
- [x] Endpoints: list, create/edit with inline SSRF errors, rotate secret, send test
- [x] Events and Settings
- [x] Empty, loading and error states from the dashboard spec

**Acceptance:** a fresh clone, seeded, shows deliveries moving through retry to failure live, without a manual refresh. Observed against the compose stack: publishing to `receiver:4000/fail-500` produced rows that reached `RETRYING` and climbed the ladder, `delivery.attempted` arrived over the socket and patched the rows in place, and the seeded history already held `FAILED_PERMANENTLY` rows at 6/6. The full ladder takes about seven hours in real time, so its end-to-end walk into the dead-letter queue is covered by the integration suite, which injects a collapsed schedule.

Two gaps the API leaves open, recorded here rather than in the specs because they are build state, not behaviour:

- `docs/dashboard.md` offers Register only when the instance has no user yet. No route reports whether any user exists, so the dashboard offers it unconditionally and lets `register` fail on a duplicate email. Closing this needs a backend probe.
- ~~Events has no endpoint of its own. The screen groups the loaded delivery rows by `eventId` and says so on screen, rather than claiming to be a complete event log.~~ Closed in phase 8.3.

## Phase 7 — Polish and release

- [x] OpenAPI generated from the zod schemas, served at `/docs`
- [x] Prometheus metrics with the documented names
- [x] `jobs` process: retention and stuck-delivery sweeper
- [x] ~~GitHub Actions~~ — dropped. The project has no CI pipeline: lint, both test suites, `prisma validate` and the Docker build are run locally and their output observed, which is what `docs/guidelines.md` now requires
- [x] `CONTRIBUTING.md`, `SECURITY.md`, issue and PR templates
- [x] README: what it does, 60-second quickstart, architecture diagram, screenshot or GIF, link to `docs/receiving-webhooks.md`

**Acceptance:** every check green on a clean checkout; following only the README, a new user goes from clone to a delivered webhook. Observed: lint, format and `prisma validate` clean in both packages, 165 unit tests and 55 integration tests pass, `docker compose up -d --build` brings all eight services up healthy, `jobs` logs both schedules running, and `/docs`, `/openapi.json` and `/metrics` answer with the documented shapes.

## Phase 8 — Visibility and alerting

Three independent steps, smallest first, each shippable on its own. None of them changes the wire contract or the queue topology, so an existing deployment upgrades by pulling and restarting.

**8.1 — The dead-letter queue stops growing without a bound**

Nothing consumes `webhook.dlq`. The message it holds carries `deliveryId` and `attempt`, both of which the committed `Delivery` row already carries, so the queue is redundant for replay and useful only as a signal: `hooktracker_dlq_size` answers "how much failed for good" without a query. Expiry is set per message rather than on the queue, because queue arguments are immutable and a `x-message-ttl` argument would turn this into a topology migration for every existing deployment.

- [x] `DLQ_MESSAGE_TTL_HOURS` in the env schema, default 24
- [x] `publisher.publishDeadLetter` sets `expiration` on the message it publishes
- [x] `.env.example` and `docs/architecture.md` §4 carry the new value
- [x] Release note: messages published before this version have no expiry and are purged once, by hand

**Acceptance:** an integration test configured with a short TTL sees the `expiration` property on the message the worker dead-letters, and sees the message gone from the queue after it elapses, against a real broker. `hooktracker_dlq_size` returns to zero without a consumer.

**8.2 — A project can be told when something breaks**

An endpoint that fails `ENDPOINT_AUTO_DISABLE_THRESHOLD` times in a row is disabled and nothing is delivered to it after that. Today the only way to learn this is to open the dashboard. The alert is operational — it is addressed to whoever runs the instance, not to the endpoint's owner — so it is configured per project, not per endpoint.

- [x] `Project.alertWebhookUrl`, optional, and its migration
- [x] The URL is validated through `resolveSafeTarget` when it is saved, and a blocked target is rejected with `422` on the settings form, exactly as an endpoint URL is
- [x] `src/shared/alerts.js` — one place that builds the body and sends it: short timeout, no retry, failures logged and never propagated into the delivery path
- [x] Three triggers: an endpoint was auto-disabled (worker), the dead-letter queue crossed its threshold (jobs), a dependency became unreachable (jobs)
- [x] `ALERT_SUPPRESSION_MINUTES` (default 60) — a Redis window per alert source, so one broken endpoint cannot produce an alert a minute
- [x] The body carries project, endpoint id, reason and time. It carries no payload, no secret and no API key
- [x] Owner-only field on the settings screen; `docs/api.md`, `docs/dashboard.md` and `docs/architecture.md` §10 updated
- [x] Requests are unsigned in this version. A receiver that needs provenance is the reason to revisit it, and that reason has not appeared yet

**Acceptance:** an integration test drives an endpoint to its auto-disable threshold and sees the alert arrive at a stub receiver; a second disable inside the suppression window sends nothing; an alert URL pointing at a private address is refused with `422` when saved; a receiver that times out leaves the delivery pipeline untouched and the failure appears only in the log.

**8.3 — Events are queryable, and payloads are searchable**

The events screen groups the delivery rows it has already loaded, because the API has no event endpoint — the gap phase 6 recorded. Search closes the question an operator actually asks: which event carried this order, and what happened to it.

- [x] `GET /v1/projects/:projectId/events` — keyset pagination, filters `eventType`, `from`, `to`
- [x] Exact-containment payload search on a caller-supplied path and value, served by a GIN index on `WebhookEvent.payload`
- [x] `GET /v1/events/:eventId` — the event with the deliveries it produced
- [x] The events screen reads this endpoint and drops the note explaining that it groups loaded rows
- [x] `docs/api.md`, `docs/dashboard.md` and `docs/architecture.md` §11 updated; the phase 6 gap note closed

**Acceptance:** an integration test publishes one event that fans out to three endpoints, sees it as a single row on the events endpoint carrying its three deliveries, finds it by a value inside its payload, and does not find another project's event holding the same value. `EXPLAIN` shows the search using the index rather than a sequential scan.

**Phase acceptance:** all three steps complete, every check in the Definition of Done run and observed, and the work released as `v0.2.0` — changelog entries moved out of `[Unreleased]`, both `package.json` versions bumped, tag and GitHub release created.
