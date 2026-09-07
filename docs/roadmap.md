# Roadmap

What hook-tracker does today is finished and released. What it does not do yet is written down here, because a gap nobody names is a gap nobody fixes.

The list came out of a deliberate audit of the whole repository — the API surface, the operational topology, the dashboard, the specifications and the test suite — after `v0.2.0`. Every item was verified in the code before it was written down. A second pass read the code for security and correctness rather than for missing features. Anything that turned out to be a defect was fixed instead of listed, and those fixes shipped in `v0.3.0`; what is left here needs a decision or a design, not a patch.

**Contributions are welcome, and this file is the place to start.** Each item says why it matters and roughly how big it is. Read `CONTRIBUTING.md` first: it carries the Definition of Done every change is held to, and this repository has no CI, so the checks are run locally and their output is the evidence.

Sizes are honest estimates for someone who has read the relevant spec in `docs/`: **small** is a few hours, **medium** is about a day, **large** is several days.

## Accounts and access

The registration model is the largest open question in the product. Today anyone who reaches the dashboard can create an account and a project. The intended model is the opposite: the first person to arrive creates their account, and after that the owner creates users for their own project. Item 1 is what closes that gap, and items 2 and 3 are what make it livable.

| #   | What                                                                               | Why it matters                                                                                       | Size   |
| --- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------ |
| 1   | An owner creates users, and open registration closes once the first account exists | `addMember` refuses an email with no account behind it, so today a teammate must self-register first | medium |
| 2   | Change password                                                                    | A password that leaked cannot be replaced; a password handed over by an owner cannot be made private | small  |
| 3   | Reset a forgotten password                                                         | There is no mail transport in the project, so an owner-driven reset is the realistic shape           | large  |
| 4   | Sign out everywhere                                                                | `logout` revokes only the refresh token in the caller's hand; other devices keep their sessions      | small  |
| 5   | Change a member's role                                                             | Today the only path is remove-then-add, which is not atomic and loses `joinedAt`                     | small  |
| 6   | Let a member leave a project themselves                                            | Removal requires an owner, with no exception for removing yourself                                   | small  |

## Data lifecycle

| #   | What                           | Why it matters                                                                                                       | Size   |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------ |
| 7   | Delete a project               | The cascades are already in the schema; there is no route that triggers them, so a project can never be removed      | medium |
| 8   | Close an account               | The same hole on the user side                                                                                       | medium |
| 9   | A backup and restore procedure | Postgres, Redis and RabbitMQ live in unmanaged Docker volumes and nothing in the repository says how to back them up | medium |

## Limits and abuse

| #   | What                                                                    | Why it matters                                                                                 | Size  |
| --- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----- |
| 10  | Pagination on the endpoint, API key and member lists                    | All three return every row in one response; deliveries and events are already paginated        | small |
| 11  | Quotas on projects, endpoints and API keys per account                  | A compromised session can create rows without any ceiling                                      | small |
| 12  | A rate limit on the dashboard's write routes                            | Only `/v1/publish` and the auth routes are limited today                                       | small |
| 13  | Refuse the `.env.example` database and broker credentials in production | `JWT_SECRET` and `SECRET_ENCRYPTION_KEY` are already refused; Postgres and RabbitMQ are not    | small |
| 14  | A password on Redis                                                     | Idempotency keys, rate-limit counters and the realtime channel rely on network isolation alone | small |

## Running it

| #   | What                                                           | Why it matters                                                                                        | Size   |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------ |
| 15  | Healthchecks for `worker`, `jobs` and `dashboard`              | `restart: unless-stopped` only catches a process that exits; one that hangs is never noticed          | small  |
| 16  | Log rotation limits in the compose file                        | The default json-file driver grows without a ceiling until the disk is full                           | small  |
| 17  | An example TLS reverse proxy configuration                     | `SECURITY.md` says a deployment terminates TLS in front of the stack, and then leaves you to write it | small  |
| 19  | Publish versioned images to a registry, with a rollback path   | Every deployment builds from source on the host; there is no artifact to roll back to                 | medium |
| 20  | Zero-downtime deployment                                       | Rebuilding `api` in place drops requests for as long as the healthcheck takes                         | medium |
| 21  | An example Prometheus scrape config, dashboard and alert rules | `/metrics` is exposed and low-cardinality, but nothing collects, draws or alerts on it                | medium |

## Testing and CI

| #   | What                                               | Why it matters                                                                                                                                               | Size   |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 22  | A CI pipeline                                      | Lint, both suites and the image build are run by hand today; nothing enforces them on a pull request                                                         | medium |
| 23  | A test for the log redaction path list             | `SECURITY.md` promises secrets never reach the logs and no test holds that promise; a typo in a path would leak silently                                     | medium |
| 24  | A test for graceful shutdown                       | All four processes share `shared/lifecycle.js` and none of its branches are covered                                                                          | medium |
| 25  | An end-to-end test that a redirect is not followed | `maxRedirections: 0` is what stops a receiver redirecting a delivery at a private address, and only a unit test guards the classification, not the behaviour | medium |
| 26  | A test setup for the dashboard package             | It has none; the sequencing, filter and pagination composables carry real logic and are unverified                                                           | large  |

## Dashboard

| #   | What                                             | Why it matters                                                                                      | Size   |
| --- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------ |
| 27  | Search and filtering on the endpoints screen     | A project with many endpoints can only be read top to bottom, unlike deliveries and events          | medium |
| 28  | Arrow-key navigation in the header menus         | They carry `role="menu"` and answer only to Tab and Escape, which is not what that role promises    | medium |
| 29  | Announce the realtime connection state           | The screen is meant to be left open; a screen-reader user is never told the socket dropped          | small  |
| 30  | Real table semantics in the settings tables      | On a wide screen the column labels are hidden, so each row reads as bare values                     | medium |
| 31  | Say how many deliveries a bulk replay will touch | The count needs an API that reports how many rows a filter matches; the screen cannot know it alone | medium |

## Hardening

These came out of the security review. Each one is a real weakness with a real fix; none is a one-line patch, which is why they are here rather than already done.

| #   | What                                                 | Why it matters                                                                                                                                                                             | Size   |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 34  | Drop a removed member's live socket                  | Room membership is read once at handshake. HTTP access ends the moment someone is removed; their open socket keeps receiving that project's delivery events until the access token expires | medium |
| 35  | Close the account-existence oracle                   | A login for an unknown email skips argon2 and answers measurably faster, and `addMember` says outright whether an email has an account behind it                                           | small  |
| 36  | Make the SSRF rejection generic to the caller        | The message distinguishes "does not resolve" from "resolves to a private address", which maps an internal DNS zone for anyone allowed to save an endpoint                                  | small  |
| 37  | Keep instance-wide numbers out of per-project alerts | A dead-letter backlog alert carries the shared queue depth to every project that configured an address, which is a side channel about the other tenants                                    | small  |

## The two large ones

| #   | What                                 | Why it matters                                                                                                                                                                                               | Size     |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| 32  | An audit trail for dashboard actions | Every delivery attempt is recorded, while who rotated a secret or deleted an endpoint is recorded nowhere                                                                                                    | 1–2 days |
| 33  | Rotating `SECRET_ENCRYPTION_KEY`     | The key can never be changed today. The shape is a keyed ciphertext format plus a re-encryption job; the risk is that a mistake here is data loss, so it needs heavier tests than anything else on this list | 1–2 days |

## Deliberately out of scope

These are not omissions, and a pull request that adds one would be changing what the project is rather than finishing it. They are recorded in `docs/architecture.md` §17.

- Payload transformation between the event and the delivery.
- Endpoint filtering beyond `eventTypes`.
- mTLS to receivers, and OAuth-signed deliveries.
- Per-endpoint ordering guarantees. Retries reorder deliveries by design, so ordering would need a different queue model, not a flag.
- Sharding of the delivery tables.
- Terminating TLS. The stack expects a proxy in front of it; item 17 documents that boundary rather than moving it.
- Sending mail. There is no transport and no plan for one, which is why item 3 is shaped around an owner rather than an inbox.
