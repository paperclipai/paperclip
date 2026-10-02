---
title: Native PubSub
summary: Opt-in signed cross-instance messaging: identity, trust, topics, delivery semantics, and operations
---

Native PubSub is an opt-in, additive protocol that lets Paperclip instances exchange durable,
signed messages (task events, chat, and CEO-to-CEO P2P) with per-company trust grants,
explicit subscriptions, replay protection, and crash-durable redelivery. It is the first
transport building block toward instance federation
([paperclipai/paperclip#1084](https://github.com/paperclipai/paperclip/issues/1084)); it does
not by itself change how a single instance works.

Everything here is inert unless the feature flag is set. With the flag unset, none of the
routes or background workers are mounted and no data is written.

## Enabling and configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_PUBSUB_ENABLED` | (unset) | Feature flag. Routes and workers are only mounted when exactly `true`. |
| `PAPERCLIP_PUBSUB_IDENTITY_PATH` | `<instance root>/data/pubsub/identity.json` (instance root is `$PAPERCLIP_HOME/instances/<instanceId>`, default instance `default`) | Private signing-identity file location. Also accepted as `createApp` option `pubsubIdentityPath`, which takes precedence. |
| `PAPERCLIP_PUBSUB_VISIBILITY_MS` | `30000` | Inbox claim visibility timeout in milliseconds. Minimum `100`, maximum `3600000`; out-of-range values fail startup. |
| `PAPERCLIP_PUBSUB_ALLOWED_PRIVATE_HOSTS` | (unset) | Comma/space-separated hostnames the operator allows as private/reserved PubSub peer destinations (loopback, RFC1918, CGNAT, ...). Peer URLs are otherwise validated to public destinations only, at trust-write time and on every dispatch. Link-local addresses (cloud metadata, `169.254.169.254`, `fe80::/10`) are denied even when listed. Also accepted as the `createPubsubService` option `privatePeerHosts`. |

The server loads the instance identity at startup when enabled, so a missing identity file is
created before the server accepts PubSub traffic (see [Identity model](#identity-model)).

Telemetry: like the rest of Paperclip, telemetry is opt-out via
`PAPERCLIP_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1`. PubSub itself does not add telemetry.

## Identity model

Each instance signs and verifies with an Ed25519 keypair stored on local disk:

- **Private identity file** — JSON `{ "version": 1, "instanceId": <uuid>, "privateKey": <PKCS#8 PEM> }`,
  written with mode `0600` (directory `0700`), size-capped at 16 KiB, created atomically
  (temp file + hardlink) so concurrent first-starts adopt one winner's complete file.
  The private key is never serialized anywhere outside the identity module.
- **Public metadata sibling** — `<name>-public.json` next to the private file, mode `0644`,
  containing only `{ version, instanceId, publicKey }` where `publicKey` is SPKI PEM.
  It is rewritten atomically on every identity load so it can never drift from the private
  file.

The `instanceId` is a random UUID chosen once at creation and stable for the life of the
instance. `GET /api/pubsub/identity` returns the public part. Onboarding
(`paperclip onboard`) creates the identity when `PAPERCLIP_PUBSUB_ENABLED=true` so the key
exists before any peer needs it.

## Route overview

All routes are company-scoped: `companyId` is read from the query on `GET` and from the JSON
body on write routes.

| Route | Actor | Purpose |
|-------|-------|---------|
| `GET /api/pubsub/identity?companyId=` | board, instance-admin | Public `{ instanceId, publicKey }` |
| `GET /api/pubsub/trust?companyId=` | board | List trust grants (including revoked) |
| `POST /api/pubsub/trust` | board | Add or replace a peer trust grant → `201` |
| `DELETE /api/pubsub/trust/:peerInstanceId` | board | Revoke trust (body `{ companyId }`) → `204` |
| `GET /api/pubsub/subscriptions?companyId=` | board | List explicit subscriptions |
| `POST /api/pubsub/subscriptions` | board | Add a subscription → `201` |
| `DELETE /api/pubsub/subscriptions/:id` | board | Remove a subscription → `204` |
| `POST /api/pubsub/publish` | board or the actual local CEO | Enqueue outgoing message → `202 { id, queued }` |
| `GET /api/pubsub/inbox?companyId=&limit=&after=` | board, CEO, or registered observer | Claim unacked messages (non-claiming for observers) → `200` page |
| `POST /api/pubsub/inbox/:id/ack` | board or CEO | Idempotently acknowledge (body `{ companyId }`) → `200` item |
| `GET /api/pubsub/history?companyId=&topic=&limit=&after=` | board, CEO, or registered observer | Non-claiming read of retained rows → `200` page |
| `POST /api/pubsub/observers` | board | Register a read-only observer agent → `201` |
| `DELETE /api/pubsub/observers/:agentId` | board | Remove an observer → `204` |
| `POST /api/pubsub/deliver` | **no local actor** — signature-only | Cross-instance delivery entry point → `200` |

Pagination on `inbox`/`history`: `limit` is `1..100` (default `50`) and `after` is the opaque
`nextCursor` from a previous page. Pages are ordered by `createdAt` then `id` (ascending).
List endpoints return `{ items, nextCursor }`; `nextCursor` is `null` when the page is final.

Authorization details:

- **Board** actors (company board tokens) can do everything in the table.
- **The actual local CEO** (persisted root CEO: `role = ceo`, no `reportsTo`, not
  `terminated`/`pending_approval`) can publish, read inbox/history, and ack — as itself.
- **Registered observers** may only *read* `fleet.chat.*` and `fleet.p2p.*` (inbox is
  non-mutating for them; history is restricted to chat/P2P topics). They cannot publish,
  ack, or administer anything.
- **Ordinary employees** are denied all PubSub routes.
- `GET /api/pubsub/identity` additionally requires instance-admin authority (local implicit
  or `isInstanceAdmin` board), because it exposes the instance's public key.

## Trust administration

A **trust grant** says: "instance A (peer) is trusted by company C to send us messages whose
topics match these patterns, from company P, over this URL."

`POST /api/pubsub/trust` body:

| Field | Description |
|-------|-------------|
| `companyId` | The local company receiving the grant |
| `peerInstanceId` | Peer instance UUID (must differ from the local instance) |
| `peerCompanyId` | Peer company UUID — checked against the envelope on every delivery |
| `publicKey` | Peer Ed25519 **SPKI** public key (PEM); normalized and re-serialized before storage, so a private key can never be persisted by accident |
| `url` | Peer delivery URL. Validated to an origin or its `/api/pubsub/deliver` endpoint with no credentials, query, or fragment. HTTPS is required except loopback HTTP (`localhost` is normalized to `127.0.0.1`). The destination is then checked against the repository's remote-HTTP egress guard: the host and its **resolved** addresses must be public unless the exact host is allowlisted via `PAPERCLIP_PUBSUB_ALLOWED_PRIVATE_HOSTS` (loopback, RFC1918, CGNAT, and other private/reserved space are otherwise rejected; link-local is always rejected). The same check re-runs on every dispatch, so a rebinding DNS answer cannot steer delivery to a private service |
| `topics` | 1–64 topic grants: exact topics or wildcards (see [Topic taxonomy](#topic-taxonomy)) |

Semantics:

- Re-posting trust for the same peer **with a different public key or peer company** rotates
  the grant: that peer's subscriptions are deleted and its undelivered outbox rows are
  cancelled in the same transaction.
- `DELETE /api/pubsub/trust/:peerInstanceId` is a soft revocation (`revokedAt` is set) plus
  the same subscription/outbox cleanup. Revoked grants never authorize delivery, and in-flight
  dispatch re-checks the grant under a row lock before sending, so revocation wins races
  against a concurrent publish.
- Trust changes are serialized with a per-`(company, peer)` advisory lock.

## Subscriptions

Trust alone is not enough: the receiving company must also hold an explicit
**subscription** row for `(peerInstanceId, topic)`.

`POST /api/pubsub/subscriptions` body: `{ companyId, peerInstanceId, topic }` → `201`. The
topic must be permitted by a matching, non-revoked trust grant, and a non-wildcard P2P topic
must bind both the local instance and the peer instance. Duplicate inserts are no-ops.
Both receiver instances of a conversation must configure their side explicitly; there is no
implicit or inferred subscription.

`DELETE /api/pubsub/subscriptions/:id` → `204` (idempotent; unknown ids succeed).

## Publishing

`POST /api/pubsub/publish` body: `{ companyId, topic, payload }` → `202 { id, queued }`.

- `topic` must be a valid fleet topic; `payload` is bounded finite JSON (≤ 64 KiB canonical).
  The complexity limits are **envelope-reserved**: a signed envelope canonicalizes as a
  fixed 12-field wrapper around the payload, so publish-time payload validation runs
  against `PUBSUB_NODE_LIMIT − PUBSUB_ENVELOPE_WRAPPER_NODES` (10 000 − 12 = 9 988 nodes)
  and depth 32 − 1 = 31, guaranteeing every signed envelope fits the full envelope budget
  (see [Envelope format](#envelope-format)).
- **Task topics are journal-only**: `POST /api/pubsub/publish` rejects any `fleet.task.*`
  topic with `403` before anything is persisted. Task events are minted exclusively by the
  activity journal worker as `from_role: "system"` (see [Activity journal task-event
  emission](#activity-journal-task-event-emission)).
- **P2P topics are CEO-only**: only the actual local CEO may publish `fleet.p2p.*`, and the
  topic must name the local instance. Board actors publish as `role: "board"` (no agent
  identity); the CEO publishes as `role: "ceo"` carrying its agent id.
- The message row and one outbox row per matching trusted peer are inserted in one
  transaction. `queued` is the number of outbox rows enqueued. Publishing to a topic no peer
  is trusted for still succeeds locally (the row is retained for history) with `queued: 0`.

## Cross-instance delivery

`POST /api/pubsub/deliver` is the only route that bypasses local actor authentication. The
receiver treats the request as an assertion and verifies it independently:

1. Envelope shape (`400` on any schema violation).
2. Recipient check: `to_instance` must be the local instance and `from_instance` must not
   be (`403` otherwise). P2P topics require `from_role: "ceo"`; task topics require
   `from_role: "system"` (`403` on either violation).
3. Trust check for `(to_company, from_instance)`: grant exists, not revoked, and the grant's
   `peerCompanyId` equals `from_company` (`403` otherwise).
4. Envelope verification: timestamp within ±5 minutes, P2P topic binds the signed endpoints,
   and the Ed25519 signature over the canonical unsigned JSON is valid against the
   trusted SPKI key (`401` on failure). The deliver route is signature-authenticated with
   no credential rate limit, so verification runs **before** the topic-grant and
   subscription scans: invalid traffic pays one trust lookup and one Ed25519 verify and
   writes no durable state.
5. Grant check: some trusted topic grant matches `to_topic` (`403` otherwise).
6. Subscription check: an explicit subscription row matches `to_topic` (`403` otherwise).
7. Ingress admission: per-peer rate (30 messages/60 s), per-company wake queue (8
   pending wakes), and pending-inbox count (200) / byte (4 MiB) quotas are checked
   before the nonce/message insert; the byte quota counts the incoming payload as
   well as stored payloads. An idempotent retry of an already stored message
   resolves before the quotas, so a full quota never turns a lost-response retry
   into `429`. Other over-quota deliveries get `429` with nothing persisted, and
   the sender's outbox retries with backpressure.
8. Nonce replay: `(companyId, peerInstanceId, nonce)` is unique per company; a repeat
   is `409`.
9. Stable-ID conflict: same `id` with different content is `409`; same `id` and content is
   accepted as a duplicate (`200 { id, duplicate: true }`) — this is how transport retries
   converge.
10. Audit: the acceptance is recorded in the company's activity journal
   (`pubsub.delivery_accepted`, system actor, actor id is the peer instance, entity is the
   message id) in the same transaction as the message insert, so accepted deliveries have
   an inspectable audit trail (the entity id joins to the durable message row, which
   carries topic and sender identity). Duplicate acceptances create no rows and add no
   entry.

Status summary for `deliver`:

| Status | Meaning |
|--------|---------|
| `200` | Accepted (or idempotent duplicate); `{ id, duplicate }` |
| `400` | Malformed envelope or configuration input |
| `401` | Signature invalid, timestamp outside the ±5-minute window, or P2P endpoint binding failed |
| `403` | Wrong recipient, untrusted or revoked peer, company mismatch, no topic grant, no subscription, P2P sender is not a CEO, or task sender is not `system` |
| `409` | Nonce replay, or stable message id conflicting with previously received content |
| `429` | Ingress admission quota exceeded (per-peer rate, per-company wake queue, or pending-inbox count/bytes) on a non-retry delivery; nothing is persisted, so the sender may retry after backoff |

Note the ordering: an untrusted sender gets `403` before any signature work; a trusted
sender with a tampered or stale envelope gets `401`. Verification precedes the
topic-grant and subscription scans, so rejected (invalid-signature) traffic does not pay
the cost of those extra lookups.

## Envelope format

Version 1, Ed25519-signed over canonical JSON of every field except `signature`:

```json
{
  "version": 1,
  "id": "0c8f…",
  "from_instance": "…uuid…",
  "from_company": "…uuid…",
  "from_agent": null,
  "from_role": "board",
  "to_instance": "…uuid…",
  "to_company": "…uuid…",
  "to_topic": "fleet.task.created",
  "payload": { "…": "finite JSON, ≤ 64 KiB" },
  "timestamp": "2026-09-30T12:00:00.000Z",
  "nonce": "…uuid…",
  "signature": "…base64url, 86 chars…"
}
```

| Field | Rule |
|-------|------|
| `id` | Stable message id (UUID). Never changes across transport retries; content is bound to it by a SHA-256 digest |
| `from_agent` | UUID or `null`; must be set **iff** `from_role` is `ceo` |
| `from_role` | `ceo` \| `board` \| `system` |
| `timestamp` | Canonical UTC ISO-8601 with milliseconds; receiver rejects anything more than 5 minutes off |
| `nonce` | Fresh UUID per attempt; the receiver keeps received nonces for 7 days (per company, per peer) and rejects replays inside that window — the ±5-minute timestamp window bounds the exposure of older replays |
| `signature` | base64url-encoded 64-byte Ed25519 signature over the canonical JSON of the unsigned fields |

Canonical JSON is deterministic (UTF-16 sorted keys, no sparse arrays, no symbol keys, no
accessors, depth ≤ 32, ≤ 10 000 nodes) so both sides hash identical byte strings. Those are
envelope-wide limits: the signed envelope is the payload plus a fixed 12-field wrapper, so
publish validation reserves that overhead — the payload alone is checked against 9 988
nodes and depth 31 — which guarantees a payload that passes publish validation always fits
once the envelope fields are added. On redelivery the sender keeps `id` and content, but
generates a **fresh** timestamp, nonce, and signature on every attempt.

## Topic taxonomy

| Family | Pattern | Publisher | Notes |
|--------|---------|-----------|-------|
| Task events | `fleet.task.created`, `fleet.task.updated`, `fleet.task.completed`, `fleet.task.blocked`, `fleet.task.comment_added` | System (activity journal scanner) | Auto-emitted on issue transitions |
| Chat | `fleet.chat.<workload>` | Board or CEO | `<workload>` is 1–64 chars of `[a-zA-Z0-9_-]` |
| P2P | `fleet.p2p.<instanceUUID-a>.<instanceUUID-b>` | CEO only | Topic must bind both signed instances; sender's instance must be one of the two |

Grants and subscriptions accept either an exact topic or a trailing-segment wildcard:
`fleet.task.*`, `fleet.chat.*`, `fleet.p2p.*`, and per-peer `fleet.p2p.<uuid>.*`. Topic
strings are at most 160 characters.

### Task event payloads

Task topics carry bounded references — never issue descriptions or comment bodies:

```json
{
  "eventId": "…activity-log event id…",
  "issueId": "…uuid…",
  "action": "issue.created | issue.updated | issue.comment_added",
  "actorType": "…",
  "actorId": "…",
  "createdAt": "2026-09-30T12:00:00.000Z",
  "details": {
    "identifier": "PRJ-123 or null",
    "commentId": "uuid or null",
    "status": "done or null",
    "previousStatus": "in_progress or null"
  }
}
```

Missing `details` fields are `null`. The source company is the envelope's `from_company`
(item `fromCompany` in local reads). Consumers that need the full content fetch the source
issue. Status transitions emit both the specific event (`completed` for `done`, `blocked`
for `blocked`) **and** the base `fleet.task.updated`; the specific event is recorded first.

## Inbox vs history

Both read `pubsub_messages`, but they serve different consumers:

- **`GET /api/pubsub/inbox`** is the claiming consumer. For board/CEO readers it locks the
  selected rows (`FOR UPDATE SKIP LOCKED`), increments `deliveryCount`, and pushes each
  row's `nextVisibleAt` to now + visibility timeout. A message therefore disappears from a
  peer's inbox for the visibility window after a claim; if the claimer dies without acking,
  it becomes visible again. Observer reads are non-mutating (no claim, no counters) and
  restricted to chat/P2P topics.
- **`GET /api/pubsub/history`** is non-claiming: it never locks, claims, or mutates
  anything, and requires an exact `topic` query parameter. It returns retained rows for that
  topic (incoming and outgoing) in `createdAt`/`id` order, and is the recommended polling
  surface for parent systems (e.g. a fleetboard) that must not disturb other consumers'
  claims.
- **`POST /api/pubsub/inbox/:id/ack`** is idempotent (acknowledging an already-acked row
  returns it unchanged), returns the item, and `404`s only for unknown ids. Ack retains the
  row in history — nothing is deleted. Crucially, ack **does not** touch the message's
  durable wake queue, so acknowledging a message never suppresses the mandatory CEO wake
  for it.
- Both pages expose `fromRole` (`ceo` | `board` | `system`) on every item alongside
  `fromInstance`, `fromCompany`, and `fromAgent`, so consumers can distinguish
  journal-minted system task events from board/CEO traffic.

## Outbox durability and redelivery

Outgoing messages are rows in `pubsub_outbox` (one per targeted peer), not in-memory jobs:

- A worker ticks every 200 ms and dispatches up to 8 ready rows per tick. Each dispatch runs
  in a transaction that first takes a shared lock on the peer's trust row (so revocation can
  never interleave an in-flight authorization) and then an exclusive lock on the outbox row
  with `SKIP LOCKED`. The **row lock itself is the lease**: if the process dies mid-dispatch,
  the lock is released by the database and the row simply retries later — there is no
  expiry-only lease gap that could double-send.
- Failures split into two classes. A **permanent** failure is a peer HTTP rejection of
  the envelope (`4xx` other than `429` backpressure) or an egress-guard rejection of the
  destination (a private/reserved address the operator has not allowlisted); it will not
  self-heal. Everything else — peer offline, connection refused, timeout, `5xx`, `429` —
  is **transient**.
- On any failure the row keeps its message, increments `attempts`, records `lastError`,
  and backs off exponentially (250 ms base, doubling, capped at 30 s). The retry signs a
  **fresh** envelope (new timestamp/nonce, same stable `id` and content), so the peer's
  replay and conflict protection apply unchanged.
- Transient failures retry **indefinitely**: a peer that stays offline for any length of
  time (well past the old fixed budget) keeps its queued messages scheduled, and the
  message delivers when the peer comes back. Outage length can never lose a message to
  budget exhaustion.
- Permanent failures are bounded: once a row's attempt counter has reached
  `PUBSUB_DELIVERY_MAX_ATTEMPTS` (40), the next **permanent** failure cancels the row —
  `cancelledAt` is set and `lastError` records the final failure plus "delivery budget
  exhausted: N attempts" — and it is excluded from further dispatch. A permanent failure
  below the budget is retried with backoff like any other. This bounds the retry loop for
  a permanently non-deliverable peer (e.g. one that never granted the topic: every attempt
  403s). The message stays in the sender's history; an operator re-publishes it (or the
  peer grants the topic) to resume delivery.
- If trust is revoked (or the topic grant no longer matches) between enqueue and delivery,
  the row is cancelled with a reason rather than delivered.
- Delivery URL validation (HTTPS except loopback, exact deliver path) happens at trust-write
  time, and the egress guard re-validates the peer's resolved address on every dispatch
  (allowlisted hosts only for private/reserved destinations), so the worker never fetches
  a caller-supplied URL and a rebinding DNS answer cannot steer delivery to a private
  service.

Incoming messages are equally durable: the full envelope is stored on the message row, and
the delivery transaction only commits after the nonce and message inserts succeed.

## Activity journal task-event emission

The `fleet.task.*` topics are driven by a scanner over the **committed activity journal**
(`activity_log`), not by live event notifications — restarts and late commits cannot lose
events. Every 250 ms it picks up to 100 issue rows (`issue.created`, `issue.updated`,
`issue.comment_added`) that have no emission receipt for their base topic, and publishes
them as `system` role. A per-`(eventId, topic)` receipt row makes emission idempotent:
re-runs return the original message id with `queued: 0` instead of re-publishing.

## CEO wake integration

Every accepted incoming message is durably queued for a mandatory wake of the company's
persisted root CEO (same CEO the API authorizes against). The wake worker, sharing the 200 ms
tick, processes `wake_pending` rows under the same row-lock lease semantics as the outbox.
The heartbeat request is enqueued with a stable idempotency key
(`pubsub:<companyId>:<fromInstance>:<fromCompany>:<messageId>`), `source: "automation"`,
`reason: "pubsub_message"`, and no run coalescing, so the wake is attributable and
non-coalesced. If the company has no eligible CEO (or the wake is skipped/unavailable), the
queue row is retried with the same backoff schedule until a durable wake receipt exists.
 A crashed-and-restarted server resumes the queue from the database; acking a message does not
clear `wake_pending`.

A service re-arm sweep covers the wake the heartbeat cancelled after this worker already
cleared the flag (a budget pause cancels the enqueued wake): it re-sets `wake_pending` for
those messages, applying the same verdict as the wake guard — a message with any delivered
receipt or any operator-stop (non-budget) cancellation stays suppressed, so a stale
skipped/budget-pause receipt from an earlier attempt cannot restart work on a message that
a later attempt already delivered. Re-arm advances `wake_available_at` only when it is in
the past, so an active retry backoff is never overridden.

Wakes are coalesced per company: while any PubSub wake for the company is in flight, or
settled within the post-settlement cooldown window (60 s, `PUBSUB_WAKE_COOLDOWN_MS`), further messages are deferred with
durable backpressure (the wake worker retries with the same backoff schedule) instead of
forking a concurrent CEO run, bounding sustained CEO execution to one run per company per
window. An in-flight wake holds its slot while its linked run shows liveness —
an unexpired controller-lease renewal, recent provider output, or a recent start
(inside the 60 s window) — so a healthy long-running wake is never bypassed by a
second message. A wake whose run the platform's own recovery (controller-lease
expiry, the periodic orphan reaper, and receipt reconciliation) has settled, or
one whose run shows no liveness at all — a SIGKILL orphan, or a run recovery
preserves non-terminal while ownership evidence is pending — stops holding the
slot once the receipt itself ages past the 60 s stale window
(`PUBSUB_WAKE_STALE_MS`); a worker sweep then reconciles such orphaned receipts
to terminal state, finished at the already-elapsed receipt touch so finalizing
an orphan never re-blocks the slot. Receipts with no run link are bounded by the
same stale window, so a crashed owner cannot hold the slot indefinitely. The
guard runs
under a company-scoped advisory lock so concurrent server instances cannot both enqueue
before either commits.

## Audit

All administrative and consumer actions are written to the company activity log under the
`pubsub` entity type with actions `pubsub.trust_added`, `pubsub.trust_revoked`,
`pubsub.subscribed`, `pubsub.unsubscribed`, `pubsub.published`, `pubsub.acked`,
`pubsub.observer_added`, and `pubsub.observer_removed`, so trust changes and message
consumption are inspectable like any other company mutation.
