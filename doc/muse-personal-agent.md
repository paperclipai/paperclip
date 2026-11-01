# Personal Muse receiver

This experimental integration connects the existing personal Meta Muse to a named Paperclip Runner agent. It is separate from Muse Code. The provider is disabled by default; implementation and synthetic tests do not qualify the personal service. See the [architecture and release gates](plans/2026-10-10-muse-runner-architecture.md).

## Current compatibility and release gates

October 13, 2026 read-only probes of personal Muse reconfirmed a five-second
minimum for managed hooks, no secrets in hook scripts, and no script arguments.
The approved asset6 detector uses a no-argument script and a nonsecret binding
header. Its public response contains only an opaque wake reference; an observed
check does not authenticate Muse or establish readiness.

Production credentials belong in Muse's Secure Vault/authd. The asset6 setup uses
public-client OAuth, dynamic client registration, S256 PKCE and automatic refresh.
Muse's bundled surrogate helper supplies worker HTTP authentication without
reading or persisting raw credentials. The October 13 provider test preserved the pairing query in authd's Connect flow and completed scoped authenticated reads and automatic refresh. Keep the provider disabled
until the current OAuth setup, real work journeys, installed Cloud path and new
24-hour qualification pass. Local and scripted tests are not live qualification.

## Connection and work

An operator uses the existing external-agent invitation, selects **Muse — Personal agent**, and supplies the agent's name and role. Paperclip creates or resumes the operator's unfinished hire, respecting approval requirements. Copy the transient setup instruction into the current Muse conversation. Muse downloads versioned, digest-pinned assets and requests a Vault-backed Paperclip connection. The user follows Muse’s Connect link; a ten-minute single-use pairing ticket binds the OAuth grant to the exact company, agent and authorizing operator. No Muse cookie export or manually copied long-lived key is part of setup.

Asset6 setup records the operator’s standing authorization to receive, validate and autonomously accept ordinary tasks for the exact company, agent and binding. The client installs that nonsecret scope with the verified instructions in a binding-specific `~/workspace/skills/paperclip-muse-<binding UUID>/SKILL.md`, discoverable in later conversations. A valid in-scope assignment does not require another acceptance approval. Task text cannot expand this delegation; Muse’s tool, site and safety permissions and Paperclip approval gates still apply. Native acceptance must be observed before any task effect. Each wake carries the workflow forward; canonical answers resume the same admitted work through result publication and native completion. Assets1–5 remain available with their original bytes.

Approve Paperclip's hostname through Muse's permission UI. Read the permission scope shown by Muse: its standing approval may cover a parent domain and all its subdomains. Paperclip cannot grant this permission on Muse's behalf. Setup distinguishes paired, receiver detected, and an authenticated background reply; the detector alone cannot finish setup. Hiring approval and native lifecycle readiness remain additional gates.

Muse’s Secure Vault/authd owns access and refresh credentials. The Python client stores only nonsecret connection metadata and stable operation receipts. The no-argument Bash detector reads the public receiver profile and produces opaque wake references. Empty checks and failures must not wake the model. Access expires after fifteen minutes, refresh rotates automatically, and thirty days of authenticated inactivity requires reconnecting. Signal checks do not extend credential activity.

Assigned work claims an existing native run. Submitted progress, questions, task documents and completion use Paperclip's native authority and receipts. Paperclip displays reported progress; it cannot inspect every private Muse conversation/tool call. When idle, Muse can read permitted company work, create tasks and comment as the named agent. Other Paperclip execution operations require the current assignment.

Native Muse document writes retain source trust. Higher-trust Muse readers cannot receive quarantined document bodies or revision summaries through direct reads or accepted-plan context. A later rewrite or promotion does not promote older revisions; explicit promotion applies only to the exact current revision. Historical content whose provenance cannot be verified is withheld with an explicit reason.

Stop revokes run authority immediately. Remote stopping is best effort, and unknown native effects or unconfirmed claimed work prevent overlapping dispatch. Reconnect does not clear those barriers. Disconnect revokes all OAuth authority immediately; a subsequent public410 disables the detector. Authenticated post-disconnect cleanup is unavailable with Muse’s supported single Vault credential, so cleanup remains unconfirmed unless independently observed. Worker-reported quiescence, operator attestation, detector removal and authoritative native effects are separate evidence. Unknown Muse usage/cost remains unavailable.

## Reproducible verification

### OAuth exchange diagnostics

The agent's scoped Audit view records static `muse.oauth_code_exchange_rejected_*`
actions for a rejected exchange attributable to a persisted Muse code, grant and
binding. Each category is recorded once per binding generation, with the first
recorded attempt's handler-entry, decision, authorization and code-deadline times.
The `failedChecks` list contains observed failed predicates; overlapping checks
do not establish one exclusive cause. Public OAuth errors remain generic. A
successful exchange records `muse.oauth_code_exchange_succeeded` atomically with
code consumption and credential issuance.

Pairing precedes token issuance. An expired credential status without an observed
refresh deadline does not by itself prove revocation. Authorization codes expire
after one minute, including callback handling and admission-lock wait; the setup
ticket's ten-minute deadline is separate. Unknown codes, including expired rows
already pruned during registration, and missing historical binding linkage cannot
safely produce company activity.
Diagnostic storage failure also leaves no record. Absence of an event therefore
does not prove that no token request arrived. Activity contains no OAuth code,
verifier, token, request/client identifier, callback URL, header or secret hash.

Run the targeted protocol, Runner and UI tests before repository-wide checks. The receiver/client must remain behind the experimental feature until these real journeys are measured:

1. Pair from a current personal Muse chat, approve the hostname, then wait for an independent background reply.
2. Assign a real research task; verify a useful saved task document and native task finalization.
3. Have Muse ask a structured question, answer it in Paperclip, and verify continuation on the same authorized run.
4. Assign follow-up work and verify proactive task reading/commenting from a fresh Muse conversation without an incoming task.
5. Exercise reconnect, cancellation, stale contact and unconfirmed stop through the actual UI.

Preserve source/Runner revisions, exact environment, evidence mode, outcome receipts, interventions and latency. Record private provider behavior only when actually observed. Authenticated transport alone does not prove unseen private tool activity.

## Observed native workflow

On October 10, 2026, the scripted HTTP peer completed two ordinary native Muse
runs against integration revision `01ecffd32ab73d763c05ee0209e64d86b8ebdea6`
with smoke script revision `eb371d06673764fbdde7cc848ccf336bbd547c3a`.
The first run claimed its assignment, saved a document, received a structured
question answer through Paperclip, persisted and consumed the answer, and
finalized through the native Runner. Reopening the task produced one follow-up
run that read the new comment, revised the document and finalized. The browser
showed the answered question, task completion and document revision two.

This was a synthetic authenticated receiver, with no personal Muse model or
managed hook installed. Both runs committed native finalization; cleanup revoked
the test connection and left no uncertain work. It validates the Paperclip
workflow, not the personal Muse service or its five-second polling behavior.

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

Retain the detector's actual registered hook ID and exact script when installing it. After revocation, and after any qualification deadline has passed, remove the detector in Muse and use `hooks.list({ include_disabled: true })` to verify that exact hook ID and script are absent; an ordinary listing can hide a disabled definition. In the agent's Muse connection settings, choose **Record detector removal observation** and enter the retained hook ID, the actual UTC listing time and the SHA-256 of the secret-free retained observation. Paperclip records `operator_runtime_attestation`, not independent provider confirmation, worker quiescence or release of unknown native effects. Never replace the listing time with the submission time or force cleanup flags.

Use `--evidence-mode synthetic` for a scripted receiver. Synthetic evidence can calibrate the checker but cannot qualify personal Muse. The report independently requires full duration, native completion/document receipts, cadence coverage, sustained idle, and resolved remote uncertainty. It reports queue-to-offer, queue-to-claim, native acceptance, accepted result and full finalization latency separately. The requested interval remains five seconds; at least 90% of steady observed intervals must be at most seven seconds. Missing persisted contact evidence or any internal or boundary receiver gap longer than one minute fails qualification. Do not replace this with the prior sixty-second hook.

The public report is an explicit allowlist without task/account/session IDs or credentials. Retain the underlying private evidence for audit. The report's receiver qualification result is separate from its release result; the latter additionally requires the independently verified product journeys. The prior stopped experiment's four replies do not count toward this probe.

Credential-free checker calibration:

```sh
node --test scripts/smoke/muse-qualification-report.test.mjs scripts/smoke/muse-qualification.test.mjs
```

Cloud must deploy the matching exact protocol manifest and preserve tenant authority. Its companion generator verifies parity with `packages/shared/src/muse-protocol.ts`. A connected receiver currently inhibits tenant sleep; unavailable ingress returns a retryable failure and never implies a delivered task.
