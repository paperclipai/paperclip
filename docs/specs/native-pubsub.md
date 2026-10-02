# Paperclip Native PubSub Specification

Status: Implemented, additive and opt-in (feature flag `PAPERCLIP_PUBSUB_ENABLED`)

Purpose: Define the protocol by which Paperclip instances exchange durable, signed
messages — issue task events, workload chat, and CEO-to-CEO P2P — with per-company trust
grants, explicit subscriptions, replay protection, and crash-durable redelivery.

This specification is the first transport building block toward instance federation
([paperclipai/paperclip#1084](https://github.com/paperclipai/paperclip/issues/1084)). It
intentionally stops short of full federation: there is no instance discovery, no company
mapping service, no cross-instance identity federation, and no change to any existing
single-instance route or behavior. Everything described here is additive; with the feature
flag unset, no route is mounted, no worker runs, and no table is written.

Related: [Native PubSub API and operations](/api/pubsub) documents the shipped HTTP
surface and operational behavior in detail.

## Normative Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `MAY`,
and `OPTIONAL` in this document are to be interpreted as described in RFC 2119.

Terminology:

- **Instance** — a Paperclip deployment with its own instance identity (one Ed25519
  keypair and one `instanceId` UUID).
- **Company** — the company-scoped principal that owns trust grants, subscriptions,
  messages, and observers.
- **Peer** — another instance explicitly trusted by a company.
- **Envelope** — the signed cross-instance message record.
- **Outbox** — the durable set of undelivered outgoing deliveries.
- **Inbox** — the claiming projection of unacked incoming messages.
- **History** — the non-claiming retained log of all message rows for a topic.

## 1. Identity

- Each instance MUST hold exactly one Ed25519 keypair for PubSub, persisted as a private
  identity file (JSON `{ version: 1, instanceId, privateKey }`, PKCS#8 PEM) with file mode
  `0600`, and a public metadata sibling file (JSON `{ version, instanceId, publicKey }`,
  SPKI PEM, mode `0644`) that MUST be kept in sync by being rewritten on every identity
  load.
- The private key MUST NOT be serialized outside the identity module, logged, or returned
  by any API.
- Instance identity creation MUST be atomic (concurrent first-starts adopt one winner) and
  stable for the life of the instance; the `instanceId` MUST be a random UUID.
- Identity creation MUST be idempotent across `onboard` and server startup, with the
  private file path configurable (`PAPERCLIP_PUBSUB_IDENTITY_PATH`).

## 2. Trust and grants

- A company MUST explicitly trust a peer before any delivery from that peer is accepted.
  A trust grant binds `(companyId, peerInstanceId)` to a `peerCompanyId`, an Ed25519 SPKI
  public key, a delivery URL, and a list of 1–64 topic grants.
- Trust writes MUST validate and normalize the public key (SPKI Ed25519 only; private keys
  MUST NOT be persistable through this API) and the delivery URL (origin or exactly its
  `/api/pubsub/deliver` endpoint; no credentials, query, or fragment; HTTPS except
  loopback HTTP).
- Peer delivery destinations MUST be validated against the repository's remote-HTTP egress
  guard: the host and its resolved addresses MUST be public unless the exact host is
  allowlisted by the operator (`PAPERCLIP_PUBSUB_ALLOWED_PRIVATE_HOSTS`); loopback,
  RFC1918, CGNAT, and other private/reserved destinations MUST otherwise be rejected, and
  link-local (cloud metadata) MUST be rejected even when allowlisted. The check MUST
  re-run on every dispatch so a rebinding DNS answer cannot steer delivery to a private
  service.
- A trust grant MUST be company-scoped and per-instance-scoped; granting trust to an
  instance does not grant trust to its other companies.
- Revocation MUST be effective immediately and win races against in-flight dispatch:
  dispatch re-validates the grant under a row lock in the same transaction as sending.
- Re-trusting a peer with a different key or company MUST revoke the peer's subscriptions
  and cancel its undelivered outbox rows atomically.

## 3. Subscriptions

- Trust is necessary but not sufficient: the receiving company MUST hold an explicit
  subscription row for `(peerInstanceId, topic)` to accept a topic.
- A non-wildcard P2P subscription MUST bind both the local instance and the peer instance.
- There MUST be no implicit, inferred, or wildcard-by-default subscription.

## 4. Envelope and verification

- Envelopes MUST be JSON version 1 with fields `id`, `from_instance`, `from_company`,
  `from_agent`, `from_role`, `to_instance`, `to_company`, `to_topic`, `payload`,
  `timestamp`, `nonce`, `signature`.
- `from_agent` MUST be set if and only if `from_role` is `ceo`; `from_role` is one of
  `ceo`, `board`, `system`.
- `payload` MUST be bounded finite JSON (≤ 64 KiB after canonicalization); canonical JSON
  is deterministic (sorted keys, no sparse arrays/symbols/accessors, depth ≤ 32, ≤ 10 000
  nodes).
- `signature` MUST be a 64-byte Ed25519 signature (base64url) over the canonical JSON of
  the unsigned fields.
- `timestamp` MUST be canonical UTC ISO-8601 with milliseconds and MUST be rejected when
  more than 5 minutes from the receiver's clock.
- `nonce` MUST be unique per sender; receivers MUST retain received nonces and reject
  replays.
- Only the exact cross-instance delivery endpoint (`POST /api/pubsub/deliver`) MUST
  bypass local actor authentication; it MUST verify envelope, recipient, trust, company
  match, topic grant, subscription, signature, and nonce in that order, and MUST report:
  `401` for invalid signature or out-of-window timestamp; `403` for recipient, trust,
  grant, subscription, or P2P-principal violations; `409` for nonce replay or a stable-id
  content conflict.
- Delivery retries MUST keep the stable message `id` and content but MUST generate a fresh
  timestamp, nonce, and signature per attempt; a repeated `(id, content)` pair MUST be
  accepted idempotently, while a conflicting `(id, different content)` MUST be rejected.

## 5. Topics

- Topics MUST match `fleet.chat.<workload>` (workload: 1–64 chars of `[a-zA-Z0-9_-]`),
  `fleet.task.<event>`, or `fleet.p2p.<instanceUUID-a>.<instanceUUID-b>`, and be at most
  160 characters.
- `fleet.task.*` events MUST be emitted by the system from the committed activity journal
  only, with `from_role: "system"`; local users MUST NOT be able to forge task topics
  through the publish route.
- Trust-model note for the receive path: `from_role` is a sender-chosen field of the
  signed envelope, and the Ed25519 signature binds the instance, not the sender's
  "system" nature. Granting a trusted peer a `fleet.task.*` topic therefore delegates
  that company's task-event provenance to the peer. Task-journal topics are excluded
  from the CEO wake and have no local consumer, so the effect is limited to the
  inbox/history provenance label.
- P2P topics MUST be published only by the actual local CEO, MUST bind both signed
  instances, and MUST include the publishing instance.
- Grants and subscriptions accept exact topics or trailing-segment wildcards
  (`fleet.task.*`, `fleet.chat.*`, `fleet.p2p.*`, `fleet.p2p.<uuid>.*`) only.

## 6. Delivery, inbox, history

- The outbox MUST be a durable per-peer row per message; dispatch leases MUST be database
  row locks released by process death, not expiry-only leases, so a crashed sender cannot
  double-deliver.
- Redelivery MUST use exponential backoff (250 ms base, doubling, 30 s cap) and MUST
  record the last error; trust revocation MUST cancel rather than deliver.
- Inbound delivery MUST enforce bounded admission before durable insertion: a per-peer
  rate quota (30 messages per 60 s window), a per-company pending-wake quota (8), and
  pending-inbox count (200) / byte (4 MiB) quotas. The byte quota MUST count the
  incoming payload as well as stored payloads, so a delivery landing just under the
  limit cannot push the inbox over it. An idempotent retry of an already stored
  message MUST resolve before the quotas: a full quota MUST NOT turn a lost-response
  retry into a rejection. Other over-quota deliveries MUST be rejected with an
  operator-visible condition (`429`) without consuming the nonce or
  storing the message; the sender's outbox provides the durable backpressure.
- Replay nonces MUST be company-scoped, and retained records MUST be bounded: nonce
  entries expire after 7 days and acked inbound history after 30 days.
- The inbox MUST be a claiming projection: claims lock rows, increment `deliveryCount`,
  and hide the message for the visibility timeout (default 30 000 ms, configurable
  between 100 ms and 3 600 000 ms). Unacked claims MUST re-appear after the timeout.
- History MUST be non-claiming and MUST NOT mutate message state; it is the recommended
  polling surface for parent systems.
- Acknowledgment MUST be idempotent, MUST retain the message in history, and MUST NOT
  suppress the mandatory CEO wake associated with the message.

## 7. Observers and roles

- An agent MAY be registered as a read-only PubSub observer for a company. Observers MAY
  read only `fleet.chat.*` and `fleet.p2p.*`; observer inbox reads MUST be non-mutating.
- Observers MUST NOT publish, acknowledge, or administer.
- Publishing requires board authority or the actual local CEO; ordinary employees MUST be
  denied.

## 8. CEO wake

- Every accepted incoming message MUST be durably queued for a wake of the company's
  persisted root CEO (the same principal the API authorizes against).
- The wake MUST use a stable idempotency key derived from company, sender instance, sender
  company, and message id; a wake that is skipped or unavailable MUST be retried until a
  durable wake receipt exists.
- The wake queue MUST survive crashes and restarts, and acknowledgment of a message MUST
  NOT clear the queue.
- PubSub wakes MUST be coalesced per company: while any PubSub wake for the company is
  live, or recently settled within the bounded post-settlement cooldown, further
  messages MUST be deferred with durable backpressure rather than forking
  concurrent CEO runs, bounding sustained CEO execution to one run per company per
  window. A live wake's slot hold MUST track demonstrated liveness of its
  linked run — held while the run still shows liveness evidence (an unexpired
  controller lease, recent provider output, or a recent start, inside a stale
  window), so a healthy long-running wake cannot be bypassed by a second
  message — and MUST release the slot once both the receipt and every
  liveness signal on the run age past that stale window, because recovery may
  preserve an ownership-ambiguous orphan non-terminal indefinitely. Receipts
  whose run settled, and receipts without a run link, MUST likewise be bounded
  by the stale window so a crashed owner cannot hold the slot indefinitely;
  orphaned receipts (stale receipt, run without liveness evidence) MUST be
  reconciled to terminal state by the service sweep without restarting the
  cooldown. The guard MUST
  run under a company-scoped advisory lock so concurrent server instances cannot
  both enqueue before either commits. A queued wake cancelled by a heartbeat budget
  pause MUST be redelivered after the pause lifts; an intentional operator stop remains
  final. The redelivery verdict is per message: a message with any delivered receipt, or
  any non-budget (operator-stop) cancellation receipt, from any earlier attempt MUST NOT
  be re-armed, so a stale skipped/budget-pause receipt cannot restart work on a message a
  later attempt already delivered.
- The wake MUST project the triggering message into the wake payload: the delivered
  envelope is carried as `pubsubMessage` — `{ messageId, topic, payload, sender: {
  instance, company, agent, role } }` — in the `context.paperclipWake` payload, and the
  wake prompt MUST render it as a `## PubSub Message` section (message id, topic, sender,
  payload). Its content is untrusted cross-company data, not board or system instruction.
- A wake for a native-runner (Paperclip Runner) CEO MUST carry a durable task scope,
  because native runner selection rejects unscoped wakes and the durable wake receipt
  would suppress redelivery. The wake is therefore associated with the company's standing
  "PubSub Coordination" issue — looked up by title, created idempotently (unassigned
  `todo`) when absent — and its id is persisted on the wake payload, context snapshot, and
  durable wake receipt, not recomputed at execution. CEOs on other adapters keep the
  unscoped wake.

## 9. Durability and audit

- Message rows, outbox rows, nonces, receipts, and wake state MUST be transactional with
  their respective operations; delivery MUST commit only after the nonce and message
  inserts succeed.
- Activity-journal emission MUST be idempotent per `(eventId, topic)` via receipt rows and
  MUST carry bounded references (identifier, comment id, status, previous status) rather
  than unbounded issue descriptions or comment bodies.
- Trust, subscription, observer, publish, and ack actions MUST be written to the company
  activity log.
- Every accepted (non-duplicate) delivery MUST be written to the company activity log in
  the same transaction as the message insert, as a system action attributable to the
  peer instance, with the message id as the entity so the audit row joins to the durable
  message row.
- Telemetry follows the instance-wide opt-out (`PAPERCLIP_TELEMETRY_DISABLED=1`,
  `DO_NOT_TRACK=1`); PubSub MUST NOT add telemetry of its own.

## 10. Non-goals (this step)

- No automatic instance discovery or rendezvous; operators exchange identities and URLs
  manually.
- No cross-instance company mapping, identity federation, or agent-directory sync.
- No changes to existing single-instance routes, auth, or data models.
- No UI surface for trust/subscriptions yet; administration is via the board API.
