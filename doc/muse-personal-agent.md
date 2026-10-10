# Personal Muse receiver

This experimental integration connects the existing personal Meta Muse to a named Paperclip Runner agent. It is separate from Muse Code. The provider is disabled by default; implementation and synthetic tests do not qualify the personal service. See the [architecture and release gates](plans/2026-10-10-muse-runner-architecture.md).

## Connection and work

An operator uses the existing external-agent invitation, selects **Muse — Personal agent**, and supplies the agent's name and role. Paperclip creates or resumes the operator's unfinished hire, respecting approval requirements. Copy the transient setup instruction into the current Muse conversation. Muse downloads versioned, digest-pinned assets and exchanges a ten-minute single-use ticket directly into private storage. No Muse cookie export or manually copied long-lived key is part of setup.

Approve Paperclip's hostname through Muse's permission UI. The standing permission covers the hostname. Paperclip cannot grant this permission on Muse's behalf. Setup distinguishes paired, receiver detected, and an authenticated background reply; the detector alone cannot finish setup. Hiring approval and native lifecycle readiness remain additional gates.

The private Python client owns access/refresh credentials and its stable operation journal. The Bash detector reads only the narrow signal profile and produces opaque wake references. Empty checks and failures must not wake the model. Access expires after fifteen minutes, refresh rotates automatically, and thirty days of authenticated inactivity requires reconnecting. Public detector checks do not extend credential activity.

Assigned work claims an existing native run. Submitted progress, questions, task documents and completion use Paperclip's native authority and receipts. Paperclip displays reported progress; it cannot inspect every private Muse conversation/tool call. When idle, Muse can read permitted company work, create tasks and comment as the named agent. Other Paperclip execution operations require the current assignment.

Stop revokes run authority immediately. Remote stopping is best effort, and unknown native effects or unconfirmed claimed work prevent overlapping dispatch. Reconnect does not clear those barriers. Worker-reported quiescence, operator attestation, detector removal and authoritative native effects are separate evidence. Unknown Muse usage/cost remains unavailable.

## Reproducible verification

Run the targeted protocol, Runner and UI tests before repository-wide checks. The receiver/client must remain behind the experimental feature until these real journeys are measured:

1. Pair from a current personal Muse chat, approve the hostname, then wait for an independent background reply.
2. Assign a real research task; verify a useful saved task document and native task finalization.
3. Have Muse ask a structured question, answer it in Paperclip, and verify continuation on the same authorized run.
4. Assign follow-up work and verify proactive task reading/commenting from a fresh Muse conversation without an incoming task.
5. Exercise reconnect, cancellation, stale contact and unconfirmed stop through the actual UI.

Preserve source/Runner revisions, exact environment, evidence mode, outcome receipts, interventions and latency. Record private provider behavior only when actually observed. Authenticated transport alone does not prove unseen private tool activity.

## Bounded 24-hour probe

`scripts/smoke/muse-qualification.ts` is an operator-run receiver reliability probe using normal task APIs. It is not a registered Product E2E campaign and cannot substitute for the real journeys above. Authenticate through `paperclipai auth login`; the probe uses the saved operator credential and never accepts a Muse cookie or credential argument. State and retained evidence should live in a private directory outside Git.

```sh
node cli/node_modules/tsx/dist/cli.mjs scripts/smoke/muse-qualification.ts start \
  --state /absolute/private/muse-qualification.json \
  --api-base https://your-paperclip-host.example \
  --company-id COMPANY_UUID --agent-id AGENT_UUID \
  --core-revision EXACT_CORE_SHA --runner-revision EXACT_RUNNER_SHA \
  --environment self-hosted --evidence-mode live

node cli/node_modules/tsx/dist/cli.mjs scripts/smoke/muse-qualification.ts check \
  --state /absolute/private/muse-qualification.json
```

Start records a fixed server-owned deadline. Run `check` regularly during the experiment (for example every five minutes using the host's supported scheduler). Each eligible hour has one deterministic task identity. Hours six through nine are reserved for sustained idle. A lost creation response retries its original idempotency key; pending work blocks later samples. There are twenty-one planned slots and at least twenty successful unattended samples are required. No direct Muse chat may be used to make a sample pass.

The server's deadline fencing is independent of the watcher. `check` also performs deadline cleanup before task/document reads, so a broken sample cannot prolong the experiment. Use `stop` with the same state path to end early. `report` reads retained evidence without creating work. If a command is killed while holding its local state lock, verify it is no longer running before removing that lock; the server deadline remains authoritative.

Use `--evidence-mode synthetic` for a scripted receiver. Synthetic evidence can calibrate the checker but cannot qualify personal Muse. The report independently requires full duration, native completion/document receipts, cadence coverage, sustained idle, and resolved remote uncertainty. It reports queue-to-offer, queue-to-claim, native acceptance, accepted result and full finalization latency separately. The requested interval remains five seconds; at least 90% of steady observed intervals must be at most seven seconds. Missing persisted contact evidence fails qualification. Do not replace this with the prior sixty-second hook.

The public report is an explicit allowlist without task/account/session IDs or credentials. Retain the underlying private evidence for audit. The report's receiver qualification result is separate from its release result; the latter additionally requires the independently verified product journeys. The prior stopped experiment's four replies do not count toward this probe.

Credential-free checker calibration:

```sh
node --test scripts/smoke/muse-qualification-report.test.mjs scripts/smoke/muse-qualification.test.mjs
```

Cloud must deploy the matching exact protocol manifest and preserve tenant authority. Its companion generator verifies parity with `packages/shared/src/muse-protocol.ts`. A connected receiver currently inhibits tenant sleep; unavailable ingress returns a retryable failure and never implies a delivered task.
