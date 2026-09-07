# hook-tracker — System Architecture & Technical Specification

## 1. Purpose & Problem Statement

hook-tracker is a distributed intermediary layer (webhook gateway) designed to reliably deliver outbound HTTP notifications (webhooks) from client backend services to third-party endpoints, ensuring zero data loss even if recipient servers are down, slow, or unstable.

It ships as a self-contained repository: `docker compose up` must bring up the full stack (Postgres, Redis, RabbitMQ, API, worker, dashboard, demo receiver) with no manual step beyond copying `.env.example`.

## 2. Repository Layout & Processes

```text
hook-tracker/
├── docker-compose.yml
├── .env.example
├── backend/                 own package.json + node_modules
│   ├── Dockerfile
│   ├── prisma/schema.prisma
│   └── src/
│       ├── api/             entrypoint: node src/api/server.js
│       ├── worker/          entrypoint: node src/worker/worker.js
│       ├── jobs/            entrypoint: node src/jobs/scheduler.js
│       ├── demo-receiver/   entrypoint: node src/demo-receiver/server.js
│       └── shared/          prisma client, queue topology, hmac, config, logger, errors
└── dashboard/               own package.json + node_modules
    ├── Dockerfile           build -> nginx
    └── src/
```

A single image is built from `backend/`; the `api`, `worker`, `jobs` and `receiver` compose services differ only by `command`. Workers scale independently via `deploy.replicas`.

| Service   | Port         | Notes                                                                  |
| --------- | ------------ | ---------------------------------------------------------------------- |
| api       | 3000         | Express + Socket.io                                                    |
| dashboard | 8080         | nginx serving the built Vue app, proxies `/v1` and `/socket.io` to api |
| worker    | –            | no exposed port, N replicas                                            |
| jobs      | –            | retention + stuck-delivery sweeper                                     |
| receiver  | 4000         | demo target that simulates 500 / slow / flaky responses                |
| postgres  | 5432         |                                                                        |
| redis     | 6379         |                                                                        |
| rabbitmq  | 5672 / 15672 | official image, no plugin required                                     |

Node 24 LTS is the pinned runtime, declared identically in `engines`, `.nvmrc` and the Docker base image. Only `dashboard` (8080) and `api` (3000) publish ports to the host; `/metrics` is mounted on the API listener, so it rides the published `api` port and is reachable from the host, not just the Docker network. A real deployment must block it at the reverse proxy. Its low-cardinality labels (§14) are what keep this non-sensitive.

### 2.1 Startup Order

`postgres`, `redis` and `rabbitmq` declare healthchecks. A one-shot `migrate` service runs `prisma migrate deploy` and exits; `api`, `worker` and `jobs` wait on `condition: service_completed_successfully` for it and `condition: service_healthy` for the infrastructure. No application process ever runs a migration itself, so concurrent workers cannot race on the schema.

Seeding is a separate opt-in command (`docker compose run --rm migrate npm run seed`) and is documented in the README as the demo path.

### 2.2 Demo Receiver

The bundled receiver exists so a fresh clone can watch the retry ladder without an external service. It logs every request with its headers and verifies the signature, then responds by route:

| Route               | Behavior                                                                       |
| ------------------- | ------------------------------------------------------------------------------ |
| `POST /ok`          | `200` immediately                                                              |
| `POST /fail-500`    | `500` always — drives a delivery to the DLQ                                    |
| `POST /slow?ms=`    | responds after the given delay, default 12000, exceeding `DELIVERY_TIMEOUT_MS` |
| `POST /flaky?rate=` | fails with `503` at the given probability, default 0.5                         |
| `GET /received`     | the last 100 requests as JSON, for assertions in tests                         |

Seed data points the demo endpoint at `http://receiver:4000/flaky?rate=0.7`, so the first minutes of a fresh install show retries, successes and a permanent failure. The seed writes a fixed signing secret taken from `DEMO_ENDPOINT_SECRET`, and the receiver reads the same variable, which is how it can verify signatures without any wiring between the two processes. That variable is demo-only and is documented as such in `.env.example`.

### 2.3 Secrets and First Run

`JWT_SECRET` and `SECRET_ENCRYPTION_KEY` have no defaults. `.env.example` carries placeholder values that are explicitly invalid, alongside the command that generates real ones (`openssl rand -hex 32`). Startup refuses to run when `NODE_ENV=production` and either value is still a placeholder, is shorter than 32 bytes, or is shared between the two. A public repository whose quickstart ships working default secrets is a public repository whose deployments all share one key.

`SECRET_ENCRYPTION_KEY` cannot be rotated without re-encrypting every stored endpoint secret; that migration is out of scope for v1 and the constraint is stated in the README rather than discovered later.

## 3. End-to-End Data Flow

```text
[ Client Backend ]
        |
        |  POST /v1/publish   (Authorization: Bearer <api_key>)
        v
[ Express.js Ingestion API ]
        |
        +---> [ Redis: Rate Limit & Idempotency Check ]
        +---> [ PostgreSQL: WebhookEvent + Delivery rows (PENDING) ]
        +---> [ RabbitMQ: publish {deliveryId, attempt} ] ---> Return 202 Accepted
                    |
                    v
         [ Node.js Delivery Worker ]
                    |
        +-----------+-----------+
        |                       |
        v                       v
 [ Success: 2xx ]        [ Failure: retryable or permanent ]
        |                       |
        +-> Postgres: SUCCEEDED |  retryable && attempt < MAX_ATTEMPTS:
        |                       |      +-> RabbitMQ retry.<ttl> queue (TTL -> DLX -> main queue)
        +-> Socket.io event     |      +-> Postgres: RETRYING
                                |
                                +-> permanent || attempt >= MAX_ATTEMPTS:
                                       +-> RabbitMQ webhook.dlq
                                       +-> Postgres: FAILED_PERMANENTLY
                                       +-> Socket.io failure alert
```

### 3.1 Event Types and Fan-out

An `eventType` matches `^[a-z0-9]+([._-][a-z0-9]+)*$`, at most 64 characters — lowercase, dot-separated by convention (`order.created`, `invoice.paid`). It is validated at ingestion, so a typo cannot silently create a new event type that no endpoint subscribes to.

`Endpoint.eventTypes` selects what an endpoint receives:

- empty array — every event type of the project
- exact entries — `order.created` matches only that type
- one trailing wildcard segment — `order.*` matches `order.created` and `order.paid`, but not `order.line.added`; `*` alone is rejected, since an empty array already means that and two ways to say one thing invite mistakes

When `endpointIds` is supplied explicitly it overrides subscription matching, but never project scoping: an id belonging to another project is rejected with `422`, and the response never reveals whether that id exists.

Publishing an event that matches no endpoint returns `422` rather than a silent `202`. Sending data nowhere is almost always a configuration error, and the caller is the only party who can fix it.

A matching endpoint that is `DISABLED` still counts as a match: the event is accepted and its delivery is recorded as `SKIPPED`. The caller's configuration is correct in that case — the endpoint was disabled by hook-tracker itself — and the audit trail is the honest answer, not a `422`.

## 4. Queue Topology (TTL + DLX chain, no plugins)

Delayed retries use per-level TTL queues that dead-letter back into the main queue. This requires no RabbitMQ plugin, so the official image works unmodified and a fresh clone needs no custom broker build.

| Object                 | Type            | Config                                                                                       |
| ---------------------- | --------------- | -------------------------------------------------------------------------------------------- |
| `webhook.exchange`     | direct exchange | main routing                                                                                 |
| `webhook.delivery`     | queue           | bound with key `delivery`; consumed by workers                                               |
| `webhook.retry`        | direct exchange | receives retry publishes                                                                     |
| `webhook.retry.1m`     | queue           | `x-message-ttl: 60000`, DLX `webhook.exchange`, DLK `delivery`, no consumer                  |
| `webhook.retry.5m`     | queue           | `x-message-ttl: 300000`, same DLX                                                            |
| `webhook.retry.30m`    | queue           | `x-message-ttl: 1800000`, same DLX                                                           |
| `webhook.retry.2h`     | queue           | `x-message-ttl: 7200000`, same DLX                                                           |
| `webhook.retry.6h`     | queue           | `x-message-ttl: 21600000`, same DLX                                                          |
| `webhook.throttle.10s` | queue           | `x-message-ttl: 10000`, same DLX — endpoint rate-limit parking, does not count as an attempt |
| `webhook.dlx`          | direct exchange | terminal failures                                                                            |
| `webhook.dlq`          | queue           | no consumer; every message carries a `DLQ_MESSAGE_TTL_HOURS` expiry, 24h by default          |

Each retry level needs its own queue because RabbitMQ expires messages only from the head of a queue; mixing TTLs in one queue would block short delays behind long ones.

**The dead-letter queue is a signal, not a store.** Its message carries `deliveryId` and `attempt`, both of which the committed `Delivery` row already holds, so replay reads Postgres and never the queue — which leaves the queue with one job: `hooktracker_dlq_size` answers "how much failed for good" without a query. Nothing consumes it, so the expiry is what keeps it bounded, and it is set on each message rather than as an `x-message-ttl` queue argument: arguments are immutable, so putting it on the queue would make this a migration for every deployment that already runs. Every message carries the same value, so they expire in the order they arrived and the head never blocks.

**Message body:** `{ deliveryId, attempt }` only. Payload and endpoint secret are read from Postgres by the worker, so the broker never stores secrets, messages stay small, and a manual replay is a plain re-publish.

Topology is declared idempotently at API and worker startup from one `shared/queue/topology.js` definition. Queue arguments are immutable in RabbitMQ: changing a TTL requires a new queue name or a manual delete, so topology changes are treated as migrations. `npm run queue:reset` performs that delete-and-redeclare in development, and refuses a queue that still holds messages unless it is forced.

**Routing keys.** `webhook.exchange` routes `delivery`, `webhook.retry` routes `retry.<level>` and `throttle.10s`, `webhook.dlx` routes `dlq`. Every object name is built from one namespace — `webhook` in every process — so an integration test can declare the same shape under its own namespace with millisecond TTLs instead of fighting the immutable arguments of the real queues.

**Publishing.** Publishes go through a confirm channel and are awaited, so the API answers `202` only once the broker has taken responsibility for the message. A channel is never created without an `error` listener: amqplib escalates an unhandled channel fault to the connection and closes it, which would turn one missing queue into a dead process.

## 5. Retry Strategy

Maximum **6 HTTP attempts**: 1 initial delivery plus 5 retries.

| Attempt | Delay before it | Queue               |
| ------- | --------------- | ------------------- |
| 1       | immediate       | `webhook.delivery`  |
| 2       | 1 minute        | `webhook.retry.1m`  |
| 3       | 5 minutes       | `webhook.retry.5m`  |
| 4       | 30 minutes      | `webhook.retry.30m` |
| 5       | 2 hours         | `webhook.retry.2h`  |
| 6       | 6 hours         | `webhook.retry.6h`  |

After attempt 6 fails, the delivery is routed to `webhook.dlq`, marked `FAILED_PERMANENTLY`, and automated retries cease. Manual replay from the dashboard creates a new Delivery row referencing the same WebhookEvent, with a fresh attempt counter and `replayedFromId` set.

**Failure classification:**

- Retryable — connection errors, DNS failures, request timeout, `408`, `425`, `429`, all `5xx`.
- Permanent (no retry, immediate `FAILED_PERMANENTLY`) — `400`, `401`, `403`, `404`, `410`, `422`, and any `3xx`, since redirects are not followed and a redirecting endpoint is a configuration error.
- When the response carries `Retry-After` and its value exceeds the scheduled delay, the next larger retry level is used instead.

Any 4xx not named above is permanent as well: a request the receiver rejected does not become acceptable by being sent again.

The SSRF guard classifies its own refusals the same way. A blocked scheme, a blocked port, an unparseable URL and an address in a private range are permanent — none of them becomes allowed by waiting. A name that did not resolve is retryable, because a resolver outage is not a configuration error, and treating it as one would fail every in-flight delivery permanently and count each one against its endpoint's health.

Delays carry ±10% jitter, applied as a per-message `expiration` no greater than the queue TTL, so a recovering downstream host is not hit by a thundering herd. The cap makes the jitter one-sided in practice — the expiration can only shorten a delay, so the spread lands in the 10% below each level rather than around it.

`MAX_ATTEMPTS` is not free-form: the ladder has exactly one queue per retry level, so the value must equal `retry levels + 1`. Startup validates this against the schedule and refuses to run on a mismatch. Changing the schedule means changing the queue set, and queue arguments are immutable — see the migration note in §4. Lowering `MAX_ATTEMPTS` to stop earlier is the only change that needs no new queue.

## 6. Delivery Execution Rules

- Timeouts are split: 3000 ms connect, 10000 ms total (`DELIVERY_TIMEOUT_MS`).
- Redirects are never followed (`redirect: manual`).
- The request body is the exact stored JSONB serialization, and the same bytes are signed.
- Response capture: status, duration, a whitelisted header subset — `content-type`, `content-length`, `retry-after`, `date`, `x-request-id` — and the first 8 KB of the body.
- An endpoint disabled while one of its messages is already queued turns that delivery into `SKIPPED` rather than sending it: the endpoint row is read at attempt time, and disabling is meant to stop traffic immediately.
- An unexpected error inside the handler — one that is neither an HTTP result nor a guard rejection — requeues the message once. A message that fails twice is acked and its delivery is left `IN_FLIGHT` for the stuck sweeper, because requeueing forever would spin on a message this worker cannot process at all.
- **SSRF guard (mandatory).** The target host is resolved before connecting and rejected when it maps to loopback, private (RFC1918), link-local (including `169.254.169.254`), CGNAT, multicast or reserved ranges. The resolved IP is pinned for the connection so DNS cannot be re-pointed between check and connect. `SSRF_ALLOW_PRIVATE` defaults to `false`; the compose demo sets `SSRF_ALLOWLIST_HOSTS=receiver` so only the bundled receiver is reachable inside the Docker network.
- Only `http` and `https` schemes are accepted; non-standard ports can be blocked via `SSRF_BLOCKED_PORTS`.
- The endpoint row is read at attempt time, not captured when the event was published. A URL or secret edited between attempts applies to the next retry, which is what makes fixing a wrong URL and waiting for the retry a valid recovery path. The event payload, by contrast, is immutable once ingested.
- **Acknowledgement:** the message is acked only after the HTTP attempt is finalized and the `DeliveryAttempt` row plus the `Delivery` status update are committed in one transaction. A worker crash before commit causes redelivery, so the system is **at-least-once** and receivers must deduplicate on `X-Webhook-Id`. Consumer `prefetch` is `WORKER_PREFETCH` (default 10).

## 7. Outbound Signature (HMAC SHA-256)

Headers on every outbound request:

| Header                | Value                                                            |
| --------------------- | ---------------------------------------------------------------- |
| `X-Webhook-Id`        | delivery id, the idempotency key for the receiver                |
| `X-Webhook-Event`     | event type                                                       |
| `X-Webhook-Attempt`   | attempt number, 1-based                                          |
| `X-Webhook-Timestamp` | unix seconds                                                     |
| `X-Webhook-Signature` | `v1=<hex>`; comma-separated when a rotated secret is still valid |
| `Content-Type`        | `application/json`                                               |
| `User-Agent`          | `HookTracker/1.0`                                                |

The signed string is `<timestamp>.<rawBody>`, where `rawBody` is the exact byte sequence sent. Receivers must reject a timestamp skew above 300 seconds and compare signatures with a constant-time function.

**Secret rotation:** `Endpoint.secret` and `Endpoint.previousSecret` can both be active. During the overlap both signatures are sent so a receiver migrates without downtime; the previous secret expires at `secretRotatedAt + SECRET_ROTATION_GRACE_HOURS`.

## 8. Idempotency & Deduplication

- Clients may send an `Idempotency-Key` header. When absent, the key defaults to `sha256(eventType + canonicalJson(payload) + canonicalJson(sorted(unique(endpointIds))))`. The target set is part of the key because the same body aimed at a different endpoint is a different instruction: without it the second publish would replay the first and its endpoint would receive nothing. A publish that names no `endpointIds` hashes exactly as it did before, so keys already issued stay valid.
- Redis key `idem:{projectId}:{sha256(key)}` stores the original 202 response body for `IDEMPOTENCY_TTL_SECONDS` (default 86400).
- A repeat within the window returns the original response with `Idempotency-Replayed: true` and creates no new deliveries.
- A concurrent duplicate (key reserved, response not yet stored) returns `409 Conflict`.
- A request that ends in an error releases its reservation, so a caller that fixed a validation failure can retry the same key at once instead of waiting out the TTL.

## 9. Rate Limiting

- **Ingestion:** sliding-window counters in Redis enforce `RATE_LIMIT_PUBLISH_PER_MINUTE` per API key (default 600) and `RATE_LIMIT_PUBLISH_PROJECT_PER_MINUTE` per project (default 6000). The project value must be at least the per-key value, so one noisy key can hit its own ceiling without exhausting the whole project's budget while issuing more keys cannot multiply the aggregate ceiling. Exceeding either counter returns `429` with `Retry-After` plus `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`; the headers and problem detail describe the counter with the least remaining capacity. Those three headers are on every publish response, so a client can slow down before it is refused. A rejected call is dropped from both windows again: leaving it there would let a client that keeps hammering push its own window forward and never recover.
- `ApiKey.lastUsedAt` is refreshed at most once a minute and never blocks the response. It is a convenience column, not an audit record, and writing it on every request would put a row lock in the hot ingestion path.
- **Per-endpoint delivery:** token bucket in Redis keyed by endpoint, sized from `Endpoint.rateLimitPerMinute`. When the worker cannot take a token it publishes the message to `webhook.throttle.10s` and acks. This does not increment `attemptCount` and writes no `DeliveryAttempt` row.
- **Auth routes:** a stricter limit to slow credential stuffing, 20 attempts a minute, counted per address _and_ per account. Address alone is not enough: behind a reverse proxy every dashboard request arrives from the proxy, so one person's failed logins would lock everyone out. Account alone is not enough either — it would let anyone lock an account they know the address of. `TRUST_PROXY` (default 0) says how many proxies sit in front of the API and is what makes `req.ip` the caller rather than the proxy. It stays off unless every path to the API goes through those proxies, because a trusted hop means the caller states its own `X-Forwarded-For` and the limiter believes it.

## 10. Endpoint Health & Circuit Breaking

`Endpoint.consecutiveFailures` increments on each permanent failure and resets on any success. The increment happens in the database rather than from the value read at the start of the attempt, so two workers failing against the same endpoint at the same moment cost two increments and the threshold means what it says. Crossing it is a separate conditional update, which is what makes the switch to `DISABLED` — and the event and alert that follow it — happen exactly once no matter how many workers cross the line together. At `ENDPOINT_AUTO_DISABLE_THRESHOLD` (default 20) the endpoint moves to `DISABLED`, an `endpoint.disabled` event is emitted, and new publishes skip it — recorded as a `SKIPPED` delivery so the audit trail stays complete. Re-enabling is a manual dashboard action.

**Alerting.** A disabled endpoint delivers nothing, so the project is told rather than left to notice. A project that set `Project.alertWebhookUrl` receives a `POST` for three conditions: an endpoint was auto-disabled, the dead-letter queue crossed `ALERT_DLQ_THRESHOLD`, and a dependency became unreachable. The two instance-wide conditions go to every project that configured an address, because a stalled broker stalls all of them.

The alert is a side channel and behaves like one: it carries `{ source, reason, projectId, occurredAt, detail }` and never a payload, a secret or an API key; it is unsigned, because the address is typed by an owner rather than negotiated with an integrator; it is sent once per `ALERT_SUPPRESSION_MINUTES` for the same project, reason and scope, claimed in Redis with `NX` so two workers noticing the same endpoint send one alert between them; it is not retried; and every failure is logged and swallowed, since a channel that cannot be reached must not take down the delivery that noticed the problem. The address is guarded by `resolveSafeTarget` when it is saved and again when it is used.

Postgres is the one dependency that cannot be alerted on: the addresses live there, so an outage takes the routing table with it. It is logged, and `GET /ready` remains the check that answers for it.

## 11. Data Model (Prisma / PostgreSQL)

```text
User            id, email (unique), passwordHash (argon2id), name, createdAt
Membership      userId, projectId, role: OWNER | MEMBER        @@id([userId, projectId])
Project         id, name, slug (unique), createdAt
ApiKey          id, projectId, name, keyPrefix (unique, indexed), keyHash (sha256),
                lastUsedAt, revokedAt, createdAt
Endpoint        id, projectId, url, description, status: ACTIVE | DISABLED,
                secret, previousSecret, secretRotatedAt,
                eventTypes String[], rateLimitPerMinute, consecutiveFailures, createdAt
WebhookEvent    id, projectId, eventType, payload Jsonb, idempotencyKey, receivedAt
                @@index([projectId, receivedAt(sort: Desc)])
                @@index([payload(ops: JsonbPathOps)], type: Gin)
Delivery        id, eventId, endpointId, status: PENDING | IN_FLIGHT | RETRYING |
                SUCCEEDED | FAILED_PERMANENTLY | SKIPPED,
                attemptCount, nextAttemptAt, lastError, completedAt,
                replayedFromId, createdAt
                @@index([endpointId, createdAt(sort: Desc)])
                @@index([status, nextAttemptAt])
                @@index([eventId])  @@index([replayedFromId])
RefreshToken    id, userId, tokenHash (unique), expiresAt, revokedAt, createdAt
                @@index([userId])
DeliveryAttempt id, deliveryId, attemptNumber, responseStatus, responseHeaders Jsonb,
                responseBodySnippet (8 KB max), durationMs, errorCode, errorMessage, startedAt
                @@index([deliveryId, attemptNumber])
```

Foreign keys that no list view filters on still carry an index, because a cascade delete and a restrict check both scan the child table.

`Endpoint.rateLimitPerMinute` defaults to 600 — high enough that a fresh endpoint is never throttled by surprise, low enough to stay a real ceiling.

API keys are stored hashed and the plaintext is shown exactly once at creation; `keyPrefix` (the first 8 characters after the `ht_` marker) is the lookup index. Endpoint secrets are encrypted at rest with `SECRET_ENCRYPTION_KEY` (AES-256-GCM).

Every dashboard query is scoped by a `projectId` derived from the membership set in the JWT, never from a client-supplied parameter.

`Membership` is the one table with no surrogate key: the pair it joins is already unique, and there is no id prefix for a row that is never addressed on its own.

**Client generation.** The Prisma v7 `prisma-client` generator writes TypeScript into `backend/src/generated/prisma`, which is git-ignored and regenerated during the image build. Node 24 runs it through type stripping, so no build step is added for a JavaScript codebase. v7 also requires a driver adapter — `@prisma/adapter-pg` over `pg`. Both details live in `shared/db.js`, the only module that imports the generated client.

**Identifiers.** Primary keys are `cuid2` values carrying a type prefix, generated in the application layer by a single `shared/ids.js` helper: `usr_`, `prj_`, `key_`, `ep_`, `evt_`, `dlv_`, `att_`, `rt_`. The prefix makes an id self-describing in logs, dashboards and support requests, and makes a wrong-entity lookup fail loudly instead of silently returning nothing.

**Time.** Every timestamp column is `timestamptz` and every value is stored in UTC. Conversion to a local zone happens in the dashboard only, and `from` / `to` filters are accepted as ISO-8601 with an explicit offset.

The GIN index on `payload` serves one query: the containment test behind the event search, `payload @> '{"customer":{"id":"cus_9"}}'`. `jsonb_path_ops` is chosen over the default operator class because containment is the only operator the search uses, and the narrower class produces a smaller index for it.

**Cascades.** `Membership`, `ApiKey`, `Endpoint` and `WebhookEvent` cascade from `Project`. `Delivery` cascades from `WebhookEvent`, and `DeliveryAttempt` from `Delivery`, which is what makes the retention job a single delete on `WebhookEvent`. `Delivery.endpointId` is `onDelete: Restrict`: deleting an endpoint with delivery history is refused, and the dashboard offers disable instead, so the audit trail cannot be erased by accident.

## 12. Authentication & Multi-Tenancy

- **Dashboard users:** email and password (argon2id). The access token is a 1-hour JWT returned in the response body; the refresh token is a 7-day opaque token in an `HttpOnly; SameSite=Strict` cookie, rotated on each use and revocable server-side.
- **Ingestion clients:** `Authorization: Bearer ht_<key>`. Lookup by prefix, verification by constant-time hash comparison, rejection when `revokedAt` is set.
- Authorization is membership-based. `OWNER` manages members, API keys and endpoint secrets; `MEMBER` has read access plus replay. The membership set is read from the database on every request rather than carried inside the access token, so removing someone takes effect at once instead of when their token happens to expire.
- Refresh tokens are stored as a sha256 hash in `RefreshToken`, never in plaintext. Using one revokes it as the replacement is issued, so a stolen token works at most once — and its use logs the legitimate client out, which is what makes the theft visible.
- Registering creates the user, a project and an `OWNER` membership in one transaction. Adding a member requires an account that already exists; v1 has no invitation flow and says so with `422` rather than pretending.

**Cookie flags.** The refresh cookie is `HttpOnly`, `SameSite=Strict`, `Path=/v1/auth`, and `Secure` whenever `NODE_ENV=production`. `Secure` is off in local development because the compose stack serves plain HTTP on localhost and a `Secure` cookie would never be stored there — a first-run failure that reads as a broken login.

**CORS.** In the compose topology nginx serves the dashboard and proxies `/v1` and `/socket.io`, so browser requests are same-origin and no CORS headers are needed. For the Vite dev server, which runs on a different port, the API enables CORS only for the origins listed in `CORS_ORIGINS`, with `credentials: true` so the refresh cookie travels. The list is empty by default: a deployment that never sets it cannot be called from an arbitrary site.

## 13. Real-Time Layer (Socket.io)

- Namespace `/realtime`; the JWT is verified during the handshake, not after connect.
- A socket joins only the `project:{projectId}` rooms its membership covers, which is what prevents cross-tenant leakage.
- Events and their payloads:

```text
delivery.created    { deliveryId, eventId, endpointId, eventType, createdAt }
delivery.attempted  { deliveryId, attempt, responseStatus, durationMs, nextAttemptAt }
delivery.succeeded  { deliveryId, attempt, responseStatus, durationMs, completedAt }
delivery.failed     { deliveryId, attempt, reason: PERMANENT | EXHAUSTED,
                      errorCode, responseStatus, completedAt }
endpoint.disabled   { endpointId, consecutiveFailures, disabledAt }
```

Payloads carry ids, never the webhook body or any secret; the dashboard fetches detail over the API when a row is opened.

- Workers hold no sockets. They publish to the Redis channel `realtime:{projectId}` as `{ event, payload }`, and API instances fan out through `@socket.io/redis-adapter`, which is also what makes multiple API replicas correct. A realtime publish that fails is logged and dropped: it must never fail a delivery that already committed. Each API instance subscribes to that channel itself and emits to its **local** sockets only — pub/sub already delivered the message to every instance, so emitting through the adapter would send one copy per replica. The adapter stays in place for emits that originate inside one API instance.
- Emissions are throttled per project (`REALTIME_MAX_EVENTS_PER_SECOND`) so a burst cannot drown the dashboard.
- A socket outlives the 1-hour access token that opened it. The server records each connection's token expiry and disconnects it with a `token_expired` reason at that moment; the client refreshes and reconnects. Sockets are not left authenticated indefinitely, and revoking a session takes effect within the access token's remaining life rather than never.

## 14. Observability

- `GET /health` for liveness with no dependency checks; `GET /ready` verifies Postgres, Redis and RabbitMQ reachability and answers `{ status, checks: [{ name, ok }] }`. Neither route is authenticated, so a failing check names the dependency but never why it failed: a client library's error text carries the internal host and port, and that belongs in the log rather than in a public response.
- `GET /metrics` in Prometheus format:

```text
hooktracker_publish_requests_total{result}
hooktracker_deliveries_total{status}
hooktracker_delivery_attempts_total{outcome,response_class}
hooktracker_delivery_duration_seconds        histogram
hooktracker_delivery_attempt_number          histogram
hooktracker_queue_depth{queue}               gauge
hooktracker_dlq_size                         gauge
hooktracker_endpoints_disabled_total
```

Labels are deliberately low-cardinality: no project id, endpoint id or URL appears in a label. Prometheus creates one time series per label combination, so a per-project label turns into unbounded series growth as tenants are added. Per-project figures come from the database through `GET /v1/projects/:projectId/stats`, which is what the dashboard uses.

`/metrics` is served by the API, but deliveries and attempts are produced by the worker, which has no HTTP port and runs at `deploy.replicas`. Nothing is summed across processes: what the worker causes is read back from the source of truth at scrape time.

| Family                                            | Type      | Source                                                                                                                                                                             |
| ------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooktracker_publish_requests_total`              | counter   | in-process, per API replica; `result` is `accepted`, `rejected` or `error`                                                                                                         |
| `hooktracker_deliveries_total`                    | gauge     | `deliveries` grouped by `status`                                                                                                                                                   |
| `hooktracker_delivery_attempts_total`             | counter   | `delivery_attempts` grouped by `responseStatus`; `outcome` is `success` or `failure`, `response_class` is `1xx`–`5xx`, `other`, or `none` for an attempt that never got a response |
| `hooktracker_delivery_duration_seconds`           | histogram | `delivery_attempts.durationMs`, one table scan per scrape                                                                                                                          |
| `hooktracker_delivery_attempt_number`             | histogram | `delivery_attempts.attemptNumber`, bucketed 1..`MAX_ATTEMPTS`                                                                                                                      |
| `hooktracker_queue_depth`, `hooktracker_dlq_size` | gauge     | `checkQueue` over the queues `shared/queue/topology.js` declares                                                                                                                   |
| `hooktracker_endpoints_disabled_total`            | gauge     | `endpoints` with `status = DISABLED`                                                                                                                                               |

Two consequences are deliberate. `hooktracker_deliveries_total` is a gauge although its name ends in `_total`: the name is fixed above, and a row moving from `PENDING` to `SUCCEEDED` is not a monotonic count. And every database- or broker-backed family is a global snapshot that each API replica reports identically — aggregate those with `max by (...)`, never `sum`; only `hooktracker_publish_requests_total` is per-replica and summed.

A scrape can never take the API down: each source is collected independently, and one that is unreachable is left out of the response rather than rendered as zero, because an absent series and a series that really is zero do not mean the same thing.

- Structured JSON logs via `pino`, carrying `requestId` on the API and `deliveryId` with `attempt` on the worker. Secrets, API keys and `Authorization` headers are removed through a pino redaction path list rather than ad-hoc string handling.
- Graceful shutdown on `SIGTERM`: stop consuming, wait for in-flight attempts up to `SHUTDOWN_GRACE_MS`, close the channel, then the connection pool. The surrounding sequence — one shutdown per process, the force-exit timer, the exit code — is `shared/lifecycle.js`, so a new entrypoint gets it by construction rather than by being copied correctly. The worker drains for a share of the grace period and leaves the rest for the closes, so the two cannot race.

## 15. Retention & Maintenance Jobs

The `jobs` process runs three schedules:

- **Retention** — deletes `WebhookEvent` rows older than `RETENTION_DAYS` (default 30) in batches, cascading to deliveries and attempts.
- **Stuck sweeper** — deliveries left `IN_FLIGHT` longer than `STUCK_DELIVERY_MINUTES` are returned to `RETRYING` and re-published, covering a worker killed between HTTP completion and commit.
- **Alert watch** — every five minutes, pings Redis and RabbitMQ and reads the dead-letter queue depth, raising the alerts of §10. The interval is deliberately long: both conditions outlive a single pass, and a short one would turn one outage into an alert every few seconds for every project.

## 16. Configuration Reference

`DATABASE_URL`, `DATABASE_POOL_SIZE` (default 10), `REDIS_URL`, `RABBITMQ_URL`, `PORT`, `TRUST_PROXY` (default 0), `NODE_ENV`, `LOG_LEVEL`,
`JWT_SECRET`, `JWT_ACCESS_TTL`, `REFRESH_TOKEN_TTL_DAYS`, `SECRET_ENCRYPTION_KEY`, `CORS_ORIGINS` (empty by default),
`DELIVERY_TIMEOUT_MS`, `DELIVERY_CONNECT_TIMEOUT_MS`, `MAX_ATTEMPTS`, `WORKER_PREFETCH`,
`MAX_PAYLOAD_BYTES` (default 262144), `RESPONSE_SNIPPET_BYTES`,
`RATE_LIMIT_PUBLISH_PER_MINUTE`, `RATE_LIMIT_PUBLISH_PROJECT_PER_MINUTE`, `IDEMPOTENCY_TTL_SECONDS`, `BULK_REPLAY_LIMIT` (default 500),
`SSRF_ALLOW_PRIVATE`, `SSRF_ALLOWLIST_HOSTS`, `SSRF_BLOCKED_PORTS`,
`ENDPOINT_AUTO_DISABLE_THRESHOLD`, `SECRET_ROTATION_GRACE_HOURS`,
`DLQ_MESSAGE_TTL_HOURS` (default 24), `RETENTION_DAYS`, `STUCK_DELIVERY_MINUTES`, `SHUTDOWN_GRACE_MS`,
`ALERT_TIMEOUT_MS` (default 5000), `ALERT_SUPPRESSION_MINUTES` (default 60), `ALERT_DLQ_THRESHOLD` (default 100),
`REALTIME_MAX_EVENTS_PER_SECOND`.

`DEMO_ENDPOINT_SECRET` exists only for the bundled seed and receiver and is absent from a real deployment.

All values are validated by a zod schema at startup; the process exits on a missing or malformed value instead of starting degraded. Validation also covers the cross-field rules stated above: `MAX_ATTEMPTS` against the retry schedule, and the production secret checks from §2.3.

## 17. Out of Scope for v1

Endpoint filtering beyond `eventTypes`, payload transformation, mTLS to receivers, OAuth-signed deliveries, per-endpoint ordering guarantees, and sharding of the delivery tables. Ordering is explicitly not guaranteed, since retries reorder deliveries by design.
