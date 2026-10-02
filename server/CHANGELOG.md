# @paperclipai/server

## Unreleased

### Minor Changes

- Add opt-in native PubSub for signed cross-instance messaging (feature flag `PAPERCLIP_PUBSUB_ENABLED`): per-company trust grants with rotation/revocation, explicit subscriptions, Ed25519-signed envelopes with canonical JSON, ±5-minute timestamp window, and nonce replay/conflict protection; durable company-scoped inbox, outbox, and history with claiming visibility timeout and non-claiming polling; CEO-only P2P topics and read-only observer agents; crash-durable outbox redelivery and mandatory CEO wake on transaction row-lock leases; and durable activity-journal emission of `fleet.task.*` events. PubSub wakes coalesce per company — in flight or recently settled within a bounded cooldown, under a company-scoped advisory lock — bounding sustained CEO execution to one run per company per window. The retention sweep never sweeps an acked message whose mandatory CEO wake is still pending, and ingress admission counts incoming payload bytes against the inbox quota and resolves idempotent retries before quota enforcement, so a full quota never rejects a lost-response retry. All board-facing PubSub routes are registered in the OpenAPI document; the signature-only cross-instance `deliver` endpoint stays excluded by design. Outbox redelivery classifies failures: transient ones (peer offline, refused, timeout, 5xx, 429 backpressure) retry indefinitely so an outage of any length keeps its queued messages, while permanent ones (peer HTTP 4xx other than 429, egress-guard rejections) retry until the row's attempt counter reaches the delivery budget (40 dispatches), after which the next permanent failure cancels the row with the reason recorded and excludes it from further dispatch, so a permanently non-deliverable peer cannot pin the retry loop indefinitely. Peer delivery URLs are validated against the remote-HTTP egress guard at trust-write and on every dispatch (public destinations only; operator allowlist PAPERCLIP_PUBSUB_ALLOWED_PRIVATE_HOSTS for private peers; link-local always denied), and every accepted delivery is written to the company activity journal in the same transaction as the message insert. All PubSub routes, workers, and behavior are inert unless the flag is set; existing route behavior is unchanged.

### Patch Changes

- Bound full-tree workspace Git scans with process-wide concurrency, queue, timeout, cancellation, coalescing, and short-lived changed-file caching. Saturated or timed-out changed-file requests now return a retryable degraded response, and hidden file-browser panels no longer initiate scans.

- A SIGKILL-orphaned PubSub wake no longer blocks a company's wake slot forever: the coalescing guard now holds the slot only while the wake's linked run shows liveness (an unexpired controller lease, recent provider output, or a recent start inside the stale window), so a receipt stuck non-terminal beside a parked orphan releases the slot once it ages out, and the service sweep reconciles those orphaned receipts to a terminal state without restarting the cooldown. Healthy long-running wakes still hold the slot for their whole run.

## 0.3.1

### Patch Changes

- Stable release preparation for 0.3.1
- Updated dependencies
  - @paperclipai/adapter-utils@0.3.1
  - @paperclipai/adapter-claude-local@0.3.1
  - @paperclipai/adapter-codex-local@0.3.1
  - @paperclipai/adapter-cursor-local@0.3.1
  - @paperclipai/adapter-gemini-local@0.3.1
  - @paperclipai/adapter-openclaw-gateway@0.3.1
  - @paperclipai/adapter-opencode-local@0.3.1
  - @paperclipai/adapter-pi-local@0.3.1
  - @paperclipai/db@0.3.1
  - @paperclipai/shared@0.3.1

## 0.3.0

### Minor Changes

- Stable release preparation for 0.3.0

### Patch Changes

- Updated dependencies [6077ae6]
- Updated dependencies
  - @paperclipai/shared@0.3.0
  - @paperclipai/adapter-utils@0.3.0
  - @paperclipai/adapter-claude-local@0.3.0
  - @paperclipai/adapter-codex-local@0.3.0
  - @paperclipai/adapter-cursor-local@0.3.0
  - @paperclipai/adapter-openclaw-gateway@0.3.0
  - @paperclipai/adapter-opencode-local@0.3.0
  - @paperclipai/adapter-pi-local@0.3.0
  - @paperclipai/db@0.3.0

## 0.2.7

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.7
  - @paperclipai/adapter-utils@0.2.7
  - @paperclipai/db@0.2.7
  - @paperclipai/adapter-claude-local@0.2.7
  - @paperclipai/adapter-codex-local@0.2.7
  - @paperclipai/adapter-openclaw@0.2.7

## 0.2.6

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.6
  - @paperclipai/adapter-utils@0.2.6
  - @paperclipai/db@0.2.6
  - @paperclipai/adapter-claude-local@0.2.6
  - @paperclipai/adapter-codex-local@0.2.6
  - @paperclipai/adapter-openclaw@0.2.6

## 0.2.5

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.5
  - @paperclipai/adapter-utils@0.2.5
  - @paperclipai/db@0.2.5
  - @paperclipai/adapter-claude-local@0.2.5
  - @paperclipai/adapter-codex-local@0.2.5
  - @paperclipai/adapter-openclaw@0.2.5

## 0.2.4

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.4
  - @paperclipai/adapter-utils@0.2.4
  - @paperclipai/db@0.2.4
  - @paperclipai/adapter-claude-local@0.2.4
  - @paperclipai/adapter-codex-local@0.2.4
  - @paperclipai/adapter-openclaw@0.2.4

## 0.2.3

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.3
  - @paperclipai/adapter-utils@0.2.3
  - @paperclipai/db@0.2.3
  - @paperclipai/adapter-claude-local@0.2.3
  - @paperclipai/adapter-codex-local@0.2.3
  - @paperclipai/adapter-openclaw@0.2.3

## 0.2.2

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.2
  - @paperclipai/adapter-utils@0.2.2
  - @paperclipai/db@0.2.2
  - @paperclipai/adapter-claude-local@0.2.2
  - @paperclipai/adapter-codex-local@0.2.2
  - @paperclipai/adapter-openclaw@0.2.2

## 0.2.1

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.1
  - @paperclipai/adapter-utils@0.2.1
  - @paperclipai/db@0.2.1
  - @paperclipai/adapter-claude-local@0.2.1
  - @paperclipai/adapter-codex-local@0.2.1
  - @paperclipai/adapter-openclaw@0.2.1
