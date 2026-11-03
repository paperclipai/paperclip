# Authenticated incoming-wake proof

The Cloud control signer can attach `idleCapabilities.incomingWake` to an owned
`task-drain:read` assertion. The tenant verifies the existing stack, action,
audience, expiry and one-use request ID, then validates the closed capability
shape. A tenant query, browser session, API key or forwarded identity header
cannot install this capability. Unknown versions and routes fail closed.

The report uses outer version 3 and includes the exact version-1 incoming proof.
Cloud compares its requested capability and the initial/final proof before stop.
Without this capability, versions 1/2 and all existing ingress blockers remain.
Older Cloud/app combinations retain their conservative behavior.

## Supported profiles

`tenant-api-http-v2` allows saved agent and board API key rows to remain while
sleeping. Cloud resolves the target from its verified host registry, coalesces a
bounded wake, waits for tenant readiness, refreshes routing, then forwards the
original HTTP request once. Ordinary `/api/instance` administration routes are
included. The separately reserved Muse protocol, non-API MCP routes, upgrades,
encoded/noncanonical paths and methods outside GET/HEAD/OPTIONS/POST/PUT/PATCH/
DELETE do not gain this wake path.

The Cloud capability authenticates the **host's ability to receive work**. Opaque
tenant keys are authenticated only by the awakened tenant, under current key,
expiry, user, membership, company, agent and resource permissions. No raw key or original
credential hash is copied into Cloud. A signed final-drain projection supplies
only per-cycle derived wake fingerprints. Unknown inputs cannot consume
provider-start quota. Tenant authentication still rejects any later revocation.

Successful current board/agent key authentication followed by a successful HTTP
response retains ten minutes of local API activity, measured with a monotonic
clock. Further successful use extends the deadline. Rejection, expiry, revoked
membership, failed requests and drain refusals do not extend it. The existing
local-work probe observes this timestamp; there is no timer, SQL, renewal or
network work from the hold, and browser-entry metrics are unchanged.

`github-broker-events-v1` uses the durable Cloud connector queue from the existing
connector-event wake protocol. The signed proof binds the current enrolled
connector instance and canonical fingerprint of all current GitHub bindings.
The tenant reconstructs those bindings through the original connection-event
owner and exact completed GitHub bot registration ownership. An active broker
bot can retain its endpoint and paired channel connection only when setup has
finished and every binding matches. Missing, foreign, changed, unsupported or
unsettled binding state prevents sleep. Original GitHub signature verification
and current endpoint/connection authorization still run on delivery.

Personal GitHub MCP connections additionally owe credential continuity work.
This change exposes their required connection IDs but keeps them blocked. The
stacked domain-deadline change must supply its inspected future continuity proof
before those rows can be exempted. A signed catalog name alone is insufficient.
Legacy scheduled alarms remain conservative when combined with ingress until
that downstream composition is present.

## Delivery and admission guarantees

Synchronous HTTP is not durable acceptance. A request arriving during stopping
or cold start is held only before forwarding, under finite capacity/time bounds.
An active-route race with tenant drain returns its real 503 and Retry-After;
clients retry through their normal API/domain idempotency contract. A streamed
mutation is never automatically replayed after an ambiguous upstream outcome.
Wake/readiness failure, manual suspension, deployment recovery holds, wrong
hosts and exhausted admission return non-success without acknowledging work.

Broker events have stronger persistence: the existing queue target survives a
lost wake hint, failed wake, process restart and lease expiry. A 202 hint does not
settle delivery. Only the current event lease acknowledgment does. Duplicate
transport delivery uses the domain's existing receipts/atomic claims.

Cloud API admission is explicitly bounded per process: 64 waiting requests,
8 per stack, 4 per source, 32 pending provider preparations; source request
budget 24/minute, source wake budget 3/10 minutes, stack wake budget 8/hour,
and aggregate wake budget 32/minute. Readiness waiting is at most 90 seconds.
A timed-out provider preparation remains coalesced until it actually settles.
The stack budget accommodates ordinary ten-minute quiet cycles with boundary
headroom. These are availability limits, not an unrestricted API promise.
Only the existing explicitly configured trusted-proxy hop contract may resolve
a forwarded source IP; otherwise the socket address is used. A shared proxy/NAT
therefore shares its source limits and can receive truthful retry refusals.

## Explicit remaining coverage

Direct GitHub, routine, Slack, voice and X webhooks retain their existing
configured-ingress blockers until their exact response budget, retry/retention,
authenticated wake and replay contracts are qualified. Cloud X forwarding by
itself does not establish wake. Saved outbound HTTP MCP remains passive under
its existing narrow rule; public MCP/SSE subscriptions, Dot, Muse and gateway
resources retain their own blockers. Discord Gateway, local MCP stdio, and other
required persistent sockets need owner-proved stop, reconnect and sequence replay.
Telegram/Teams/Photon transports require their own actual producer/lifecycle
classification. Hosted previews belong to their separate ingress changes.

The source/loopback/PostgreSQL tests establish the exercised protocol boundaries;
they do not establish a fleet deployment, actual provider/Neon suspension,
provider startup latency or cost savings. Deployed combined qualification remains
separate and must include every enabled transport.


## Pre-wake API admission

The v2 API profile requires an authenticated per-sleep-cycle key projection before compute stops. The signed challenge is derived from the newly random owned idle hold and stack. In the same read-only snapshot, the app projects up to 1000 active key rows into domain-separated salted fingerprints; original key hashes and raw keys stay private. Board-key expiry is carried and enforced before wake. Unknown, duplicate, malformed or overflow projection fails closed. The complete initial and final receipts must match; changing a credential or challenge refuses stop.

Cloud stores the final receipt in one internal stack column under the sleep operation lock. Unknown requests cannot consume provider-start quota. Possession of a matching snapshot key only admits a bounded wake; tenant authentication and current permissions still run on delivery. A key revoked after the snapshot can therefore receive no tenant authority, even if it once qualified for wake. Wake claims recheck the exact cycle, matching key and expiry atomically. Normal next sleep re-reads revocations. Successful wake, manual/archive/delete or a known sleep abort clears the receipt; uncertain stop and a same-cycle failed wake retain recovery. A restarted host reads the durable receipt. No global TTL strands nonexpiring saved keys during long sleep, and no periodic credential refresh worker is added.


Removed GitHub endpoints are retained history only after the ordinary removal
writer archives the endpoint with its timestamp and generation, archives and
disables the same-company channel connection, clears its credential references,
and releases endpoint leases. Any retained lease, incomplete registration or
malformed cleanup state still blocks. This exemption covers only GitHub; archived
persistent transports remain blocked. Actions, deliveries and publications keep
their separate completion checks even when their endpoint has been removed.

The service also keeps its existing local-work probe active while runtime
initialization or retirement is unsettled. Both supported runtime registries
report failed retirement even after `get` and `list` hide the runtime. Successful
owner retry clears that debt; a failed full service shutdown retains the probe.
These checks read process-local state and add no polling, network or SQL.
