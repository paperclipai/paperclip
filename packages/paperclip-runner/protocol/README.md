# PRP v1/v2 Contract

The JSON Schema files in `schemas/` are the language-neutral source of truth for
Paperclip Runner Protocol versions 1 and 2. The fixtures in `fixtures/` define
accepted and rejected compatibility cases.

## Compatibility

- `protocolVersion`, `fixtureVersion`, and `event.schemaVersion` are required.
- A consumer fails closed when a required version or schema discriminator is
  not supported.
- A v1 envelope can contain an unknown optional property when its schema marks
  that object as extensible.
- A consumer ignores an unknown optional property until a later contract gives
  it meaning.
- A required field, enum value, or typed structured-input field is not optional.
- Question and answer identifiers are stable across the provider boundary.
- Peers negotiate the highest mutually supported protocol version. Existing v1
  runners remain compatible but cannot receive v2-only session-goal commands.

The `unknown-optional-fields.json` fixture must be accepted. The
`unsupported-required-version.json` fixture must be rejected.

## Session goals (v2)

PRP v2 adds a provider-neutral durable session-goal lifecycle. Every v2
capability snapshot includes `sessionGoals`, even when its availability is
`unsupported` or `policy_disabled`. Paperclip sends controls only when the
negotiated capability advertises the corresponding action.

Commands:

- `session.goal.get`
- `session.goal.set` for objective, status, and optional token budget changes
- `session.goal.clear`

Events:

- `session.capabilities.updated`
- `session.goal.snapshot`
- `session.goal.updated`
- `session.goal.cleared`

Goal state is separate from Paperclip's company/business goal hierarchy. The
snapshot distinguishes the durable status from `workingNow`, because an active
goal can be idle between autonomous turns. A runner emits the full capability
and authoritative snapshot after every session open or resume. Missing v1
capability is unsupported; clients do not infer support from an adapter name.

## Harness credential updates

`auth.credentials.updated` is a P0 runner event available in the v1, v2, and v3 event
schemas. Its payload uses `paperclip.auth.credentials.updated.v1` and contains
only `provider`, `bindingId`, `revision`, and `detection`. No tokens, account
identifiers, credential paths, or credential fingerprints are permitted.

An updated consumer opts in with `observeCredentials: true` in `run.prepare`,
before `session.open`. The bundled runner transport opts in for fresh sessions;
set its `observeCredentials` option to `false` to disable observation for a
fresh session. Older hosts that omit the field receive no new event. Consumers
must update their schemas before opting in: an event-enum addition is not an
unknown optional property. Existing runner binaries ignore the optional flag
and do not provide observation; absence of an event does not establish support.

The current Unix runner observes native Codex's managed `CODEX_HOME/auth.json`
and the Codex/Grok ACPX session homes. It uses a non-recursive directory watch
plus a one-second polling fallback, so atomic file replacement is handled.
Grok's initial inline subscription credential is the baseline, allowing a
refresh during launcher startup to be detected. A first valid credential file
without a prior baseline establishes the baseline without claiming a refresh.
Account identity changes also emit updates, even when token values stay the
same, and establish the baseline for later refreshes on the new account.
Hosts must evaluate the current credential through their private credential
channel and account checks; the event does not authorize an account switch.
Metadata-only changes, partial writes, and deletion do not emit updates.
Unsupported harnesses and refreshes retained only in memory need
their own observer or native-hook integration; adding this event does not make
them observable.

`bindingId: "harness-auth"` identifies the selected harness authentication
within the envelope's normalized session. Revisions increase for that binding
and survive runner restarts and warm run attachments. The baseline fingerprint
and pending event are persisted together in a private runner state file. Source
retries retain the same event identity until the durable PRP outbox accepts it.
Hosts should commit an idempotent reaction or durable work item through
`onCommittedEvent` before returning and advancing the cumulative ACK.
The bundled transport exposes `onCredentialsUpdated(event)` for this commit.
It awaits the callback before ACK, including during warm idle, attachment, and
provider cleanup. Callback failures leave delivery unacknowledged for retry;
callbacks must therefore deduplicate by the original source event identity.
When configured, credential updates bypass the turn notification queue.
Paperclip commits them directly to the run log in a separate credential source
namespace, preserving the original PRP envelope and avoiding collisions with
the driver's normalized event sequence. A turn-only notification consumer
cannot reliably handle idle or cleanup updates; use this callback instead.

`detection: "credential_store"` reports an observed credential change, not proof
that an OAuth refresh succeeded. Multiple changes between observations can be
coalesced; this is not an audit of every refresh exchange. The schema also
allows `native_hook` for integrations with an explicit signal. Observation
continues during warm idle and checks at turn terminal and close boundaries,
including Grok's private refresh handoff after live-store cleanup. Retained
runner observations enter the durable outbox before a suspend or shutdown
command completes, without draining the provider backlog. A final check after
provider cleanup also enters the outbox and waits for the host ACK. The runner
retains its terminal recovery fence if that delivery fails.

The event authorizes no credential access or write on its own. A host that
needs rotated token values must use a separately authorized handoff with its
existing account-identity and freshness safeguards. The default Paperclip
credential copy-back behavior remains in place.

## Scope

The first provider descriptor and adapter fixture cover Codex only. The schemas
for provider-neutral events and semantic receipts do not enable those actions.
Discovery and authorization are separate contracts.

The conformance manifest records every source file and its SHA-256 digest. Run
`pnpm generate:protocol-manifest` from this package after a source change. CI
runs the same generator with `--check` to reject drift. This check also compiles
the JSON Schemas and validates every replay, question, and cross-language
conformance fixture against its declared schema.

The files in `fixtures/replay/golden/` are deterministic reducer oracles. Each
accepted replay fixture has a complete session snapshot and a compact parity
summary. `pnpm generate:replay-goldens` updates them after an intentional
reducer change; package build and CI fail when they drift.

The files in `fixtures/local-runner/scripts/` drive the package-local fake
harness. They cover successful, failed, interrupted, interactive, duplicate
terminal, process-cleanup, and oversized-frame behavior without starting a
production adapter.
