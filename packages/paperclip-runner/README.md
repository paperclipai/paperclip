# Paperclip Native Runner

This package is the standalone development boundary for Paperclip's native
runner protocol, process supervision, durable transport, provider drivers, and
normalized session backends. Rust owns the production runner under `runner/`;
TypeScript provides the control-plane reference, browser SDK, scenario tools,
and conformance oracle.

The package includes one coherent set of capabilities: PRP v1 validation and
replay, a supervised local runner with a scripted fake harness, durable
WebSocket delivery and recovery, qualified Codex, OpenCode, ACPX, Claude
Managed, and AWS AgentCore drivers, live
session and issue-thread surfaces, a public browser/React SDK, a standalone
adapter demo, and a deterministic mock control plane. None of these surfaces
imports or starts Paperclip's server, UI, CLI, or production database.

Connection continuations inspect the harness descriptor's optional
`toolRefreshOnResume` capability. Native Codex, Claude Managed Agents, AgentCore,
OpenCode, and qualified Claude/Codex/Grok ACPX profiles expose it; unqualified
harnesses leave it false or absent. Changing tools can replace a provider process while retaining
the provider conversation. Company, agent, task, workspace, model, instruction,
and skill compatibility still gate recovery. An MCP-only assignment change can
resume only when the selected harness explicitly supports refreshing tools.

When recovery needs a fresh conversation, the server supplies a deterministic
handoff through a lazy history loader at the fresh attempt boundary.
It includes the original request, recent messages, resolved interaction
summaries, agent replies, and document excerpts, with source identities and
retrieval instructions. Reads and excerpts are bounded; the handoff has a
24,000-byte ceiling and explicit truncation/omission markers. Conversation
reset boundaries, deleted messages, source quarantine, and secret redaction
apply before model submission. Successful recovery does not fetch or replay the
handoff.
Legacy adapters advertise `supportsToolRefreshOnResume` for their selected
harness: Claude and Codex CLI/ACP, Grok CLI, Gemini/Kimi CLI/ACP, and
Cursor/OpenCode/Pi CLI. CLI adapters using environment tool delivery start each
invocation with current endpoints and credentials, including resumed turns. ACP reloads
current MCP bindings, including run-scoped credentials, while preserving the
conversation; an unqualified/custom harness retains its restart fence.
Legacy fresh attempts receive the same bounded handoff, including resume-failure
fallbacks. Provider
authentication repairs retain their existing fresh-session recovery behavior.

## Public package surfaces

- `@paperclipai/paperclip-runner` — production contracts, clients/backends,
  PRP validation/replay, canonical catalog/dispatcher, and compatibility check.
- `@paperclipai/paperclip-runner/testing` — deterministic mocks plus PRP and
  semantic conformance kits. Tests and external conformance consumers import
  this explicitly.
- `@paperclipai/paperclip-runner/evals` — versioned native-attempt metadata,
  fail-closed package/binary compatibility checks, and explicit runnerd
  artifact resolution for eval consumers.

The package root has no mock or scenario exports. Generic credential-free
matrix orchestration lives in the workspace-private
`@paperclipai/paperclip-eval-kernel`; scenario content and provider-backed eval
campaigns remain outside the runtime package.
See [ADR 0001](docs/adr/0001-runner-testing-eval-package-boundaries.md).

The two conformance surfaces intentionally prove different contracts. The
existing `runControlPlanePortConformance` suite checks narrow PRP run/event
persistence. `CAPABILITY_HIGH_RISK_SEMANTIC_VECTORS` and
`runSemanticConformanceKit` compare normalized tool authorization, state,
effects, audit, retries, conflicts, redaction, continuation, and terminal
decisions. The production adapter stays App-owned and invokes Paperclip's real
route/service authorities; it does not copy those rules into this package.

Provider-facing `paperclip_finish` accepts an omitted or `null` continuation for
`done`, `completed`, and `needs_review`. This supports gateways that require all
declared tool properties to be present. Normalization removes only `null`;
non-yielding tool calls still reject a continuation object, and `yielded` still
requires a complete `response_wake` object.

## Quick start

Native provider debug-trace correlation uses an incremental index owned by its transport. Pending
event lookups read only newly appended bytes, with a 1 MiB read budget per lookup;
they retry until the observed suffix is indexed. Partial records remain pending,
and trace replacement or truncation invalidates the index. Closing a transport
clears its index. Other active transports cannot evict its progress. Records over
64 KiB are skipped by the correlation index without buffering or parsing their
full contents; the original trace file retains them. Do not restore a full
synchronous trace scan for each pending event: it blocks event delivery and can
leave the board showing an active run after the provider turn has already ended.

The package also builds `paperclip-runner-acpx-sidecar`. This bounded v2
stdin/stdout bridge admits the pinned Claude and Codex ACPX profiles. It
validates the exact model, session identity, tool catalog, structured input,
and terminal settlement at the process boundary. Cursor, Copilot and Pi have
separate candidate branches and remain unavailable in production until local
and Daytona qualification passes. Their verified distributions are build-owned;
no candidate accepts an arbitrary executable. See
[the rich ACP capability report](../../doc/architecture/runner-rich-acp-capabilities.md).

Remote Codex sessions relay assigned app tools through the server's configured
gateway. Small catalogs are sent directly. When a catalog would exceed the
runner's 256-operation or 768 KiB contract limit, the server exposes
`paperclip_search_assigned_tools` and `paperclip_call_assigned_tool` instead.
Search returns bounded pages of names, descriptions, and input schemas. Each
page intersects the session's pinned assignments with current gateway grants.
An individual schema that exceeds a page returns an `inputSchemaRef`. The same
search tool retrieves that schema in chunks via `schemaTool` and
`schemaOffset`; discovery can continue past the large tool.
Calls retain task ownership, work-mode restrictions, gateway authorization,
approvals, and audit. Core task tools and the runner's completion tools keep
their reserved space; no assigned tools are silently removed to fit the limit.

Native Claude skill assignments travel in the runtime-context snapshot through
runnerd to the ACPX sidecar. After acquiring the provider lifetime lease, the
host materializes the assigned bundles under the isolated Claude home's
`skills/` directory before launch. Reopening a provider refreshes that snapshot;
project and ambient host settings remain excluded. This path is separate from
the legacy `claude_local` adapter's remote skill staging.

The isolated Claude settings pin both `model` and `availableModels` to the
user's requested ID. This keeps ACP from replacing an exact ID with a picker
alias during selection and verification. Users can keep selecting models from
the normal Claude catalog or entering custom IDs; unavailable models still fail
at the provider rather than silently falling back.

ACPX Claude defaults to `approve-all`, shown as **Full auto (approve all)**.
OpenCode defaults to `allow`; native Codex defaults to `never` (no approval
pauses). These defaults cover all assigned tools and connections, including
provider-native operations. Full auto is resolved consistently for agent
creation, adapter conversion, direct driver launches, and fresh/resumed turns.
Explicitly stored restrictive modes still apply.

The runner's authenticated bridge and controller still enforce company access,
action claims, task modes, and governed approvals. Provider permission defaults
do not change workspace isolation or grant credentials or connection access.
`approve-paperclip` remains an optional narrower mode for assigned planning and
task tools; `approve-reads` allows assigned reads; `deny-all` rejects requests.
None of these restrictive modes is the default.

Restrictive profiles route supported permission decisions through durable runtime
requests and the existing task interaction controls. Requests are persisted
before presentation; answers are checked against the offered decisions and
acknowledged by the sidecar before settlement. Unknown, stale and duplicate
responses fail. Missing provider decision support remains a blocked disposition,
not implicit approval. Company access checks still run for each Paperclip tool.
Provider death expires pending promises; approvals are never replayed into a
replacement process.

Automatic Paperclip/read allowances currently require the Claude SDK dispatch
boundary. Grok preserves these restricted settings, but its ACP requests lack
independently bound tool authority. Those operations require a supported operator
permission decision; a missing interactive responder stops with
`approval_required`. An explicitly selected `approve-all` policy permits unattended
Grok work in an assigned sandbox. Paperclip authorization and governed approvals
still apply.

Runnerd selects only qualified provider profiles. Claude Managed and AWS
AgentCore receive immutable company-profile snapshots with explicit retention,
spend, and invocation limits. No provider process receives a Paperclip API
credential or unrestricted server environment.

Claude Managed resolves its API key from the company secret bound to the
selected profile. AWS AgentCore uses workload identity only; long-lived static
AWS access keys are intentionally removed from the runner environment.

The Rust core includes a bounded client for the sidecar protocol. It enforces
request identity, event order, frame and queue limits, timeouts, redacted
diagnostics, and process-group cleanup. Runnerd selects this package-local
transport only through an exact qualified provider descriptor.

Before a later provider adapter consumes a valid sidecar event, the Rust core
also requires its optional or mandatory run and turn scope to match the active
execution. Process and diagnostic events can remain global. All operational,
tool, input, permission, and terminal events require the exact active binding.

A package-local payload boundary decodes events only after that scope check. It
validates control identities, terminal status, question sets, and the admitted
runtime event types and bounded fields. It redacts diagnostic and retained
event values again before they can enter provider state. Authoritative semantic
tool arguments are validated for transport bounds and forwarded unchanged,
including credential-bearing document and instruction content. The provider
harness owns credential policy; redaction of logs and audit previews must not
reject or rewrite execution arguments. Diagnostic detection requires explicit
credential fields/assignments or recognizable key, Bearer, JWT, or PEM formats,
not ordinary prose such as "credential handling" or dotted filenames.

Human question tools accept one complete `payload.questionSet` for text and
choice questions. The control plane generates legacy `questions` entries with
stable free-text option IDs. Legacy callers remain supported. Calls that supply
both forms must describe the same complete form; partial forms remain invalid.
The native recovery bridge uses the same projection for answer delivery.

The server validates canonical answer constraints before persistence. Regex
matching runs in isolated workers with a one-second deadline and at most four
active workers. A timeout or capacity error leaves the question pending. The
ordinary and native answer paths both await this validation before persistence.
Saved native answer delivery does not repeat regex matching.

Validated ACPX runtime events normalize into the same provider-neutral activity
families as the direct Codex transport. Reasoning contents stay private. Tool
targets are resolved within the workspace under the provider host's path
semantics and receive a versioned sidecar boundary marker before becoming
bounded, display-only PRP safe paths. Raw or unmarked provider locations fail
closed. URI-scheme and Windows drive-shaped values require a separate sidecar
attestation backed by an existing in-workspace entry or, for a not-yet-created
edit target, an existing in-workspace parent. This preserves real POSIX colon
filenames without treating arbitrary URI text as a path. Windows separators
are canonicalized, and consumers must not reinterpret the display value as
file-access authority. Operational semantic-result and terminal events remain
reserved for the stateful adapter rather than being duplicated.

The ACPX provider reducer preserves that order while it tracks one
active turn, bounded assistant text, semantic results, and pending tool or input
correlations. Terminal events flush the final assistant message first and clear
unresolved turn-scoped requests.

The package-local session bootstrap starts the bounded sidecar transport,
verifies the qualified capability handshake and effective model, opens one
identity-bound session, and confirms its run attachment. Any failed bootstrap
terminates the process; session shutdown preserves persistent provider state.
The session can then start one immutable-workspace turn, request interruption,
and reduce polled events through the scope-first state boundary. A mismatched
command acknowledgement or invalid event terminates the session fail closed.
Polled semantic calls pass through the run-scoped authorized tool bridge before
they can be returned to a caller. Before a follow-up turn releases settled tool
receipts, runner-core suspends and reaps the idle sidecar/provider generation,
then resumes the same verified persistent identity in a fresh generation. This
prevents a late session-lifetime MCP callback from inheriting the next turn's
event authority.

The Rust question-response validator checks the versioned response envelope
against the exact persisted question IDs, answer modes, options, required
answers, custom-answer policy, and text constraints before provider delivery.
Tool results and structured question responses then use two-phase resolution:
validate retained identity and schema, require the exact sidecar
acknowledgement, and only then clear pending local state. Codex permission
requests violate its pinned sidecar policy and terminate the session fail
closed.
Safe suspension is available only with no active turn or pending request. The
sidecar must return the exact persistent session identity before runnerd
terminates the local process.
Already validated ACPX reducer events project into provider-neutral durable
events only with an exact run, session, turn, and item binding. Raw sidecar
envelopes and permission requests are not admitted at this boundary.
A safely suspended session can be recorded as a bounded private checkpoint.
The checkpoint binds the exact provider identity, run, catalog revision, and
catalog digest and is replaced atomically before a later recovery attempt.
Recovery releases the stored identity only after those bindings match the
prospective session configuration exactly.

Run the complete contract gate with:

```sh
pnpm install --filter @paperclipai/paperclip-runner --lockfile=false --offline --ignore-scripts --dev
pnpm --filter @paperclipai/paperclip-runner verify
```

The verification command requires a stable Rust toolchain with `cargo` on
`PATH`, in addition to Node.js 24.11+ and pnpm 9+.

Minimal Debian/Ubuntu hosts without root access can extract the required
Playwright browser libraries into a user-owned cache and run the same acceptance
sequence with:

```sh
pnpm --filter @paperclipai/paperclip-runner verify:rootless
```

The tracer's final line is stable:

```json
{
  "schemaVersion": "paperclip.runner.conformance.output.v1",
  "runIdentity": {
    "runId": "run_conformance_0001",
    "sessionId": "session_conformance_0001"
  },
  "result": {
    "status": "succeeded",
    "summary": "Standalone Conformance fixture accepted."
  }
}
```

Run only the tracer with:

```sh
pnpm --filter @paperclipai/paperclip-runner trace:conformance
```

Replay the Replay happy path, run a Local session, or open the browser
devtool:

```sh
pnpm --filter @paperclipai/paperclip-runner replay:fixture
pnpm --filter @paperclipai/paperclip-runner trace:local-runner -- --scenario happy-path
pnpm --filter @paperclipai/paperclip-runner trace:codex
pnpm --filter @paperclipai/paperclip-runner demo:live-console -- --host 127.0.0.1 --port 4174

# Live console: chat with a live session in the browser.
pnpm --filter @paperclipai/paperclip-runner console:live-console
pnpm --filter @paperclipai/paperclip-runner browser:dev --host 127.0.0.1 --port 4179

# SDK: open the public-SDK reference console and mini consumer.
pnpm --filter @paperclipai/paperclip-runner console:sdk

# Standalone: run the standalone legacy/native/kill-switch tracer and page.
pnpm --filter @paperclipai/paperclip-runner trace:standalone
pnpm --filter @paperclipai/paperclip-runner trace:standalone -- --feature-flag enabled
pnpm --filter @paperclipai/paperclip-runner trace:standalone -- --feature-flag enabled --kill-switch enabled
pnpm --filter @paperclipai/paperclip-runner demo:standalone

```

Live console provider-backed routes are loopback-only and reject wildcard/LAN
binds. Browser mutations require same-origin Fetch Metadata, matching Origin,
and JSON content; see the protocol-server tutorial for direct `curl` examples.

## Direct live protocol qualification

The canonical direct live protocol suite lives in the separate
`paperclip-evals` repository under `evals/paperclip-runner/`. Its
`live-mini.json` roster is the complete 35-case Codex qualification lane. Build
this package's TypeScript output, release `paperclip-runnerd`, package tarball,
and `dist-issue-thread` viewer, then use the roster runner documented in that
repository. The package ships the required orchestration entry point as
`paperclip-runner-eval-session` (`dist/cli/eval-session.js`). Evalbook owns the
consistent HTML matrix and read-only attempt drill-down pages.

The hosted full-campaign workflow, parallel matrix, credential boundaries,
canonical report merge, and versioned S3 index are documented in
[`docs/runner-protocol-live-evals.md`](docs/runner-protocol-live-evals.md).

This direct protocol qualification is separate from the stress-derived Runner
workflow schedule below and from the full-stack browser model E2E suite.

## Stress-derived workflow, chaos, and AWS AgentCore operations

The deterministic workflow scorer and the chaos schedule do not require
provider credentials:

```sh
pnpm --filter @paperclipai/paperclip-runner test:runner-workflow-evals
pnpm --filter @paperclipai/paperclip-runner report:runner-chaos-evals
```

`report:runner-live-evals` is a paid, provider-backed command. Native Codex
requires `OPENAI_API_KEY`; ACPX Claude requires
`ANTHROPIC_API_KEY`; OpenCode candidates require `OPENROUTER_API_KEY`. The live
matrix remains qualified-only and does not persist credential values. Candidate
qualification uses `eval-session --candidate-profile <pi|cursor|copilot>` with an
explicit model and a separately materialized pinned candidate pack. This option
is a constructor-bound diagnostic opt-in; session JSON cannot enable a candidate.
Missing credentials or unverifiable spend block paid qualification. Set
`PAPERCLIP_EVAL_MAX_CAMPAIGN_COST_USD` to a positive finite number to bound
additional scheduling after the observed campaign total reaches that value:

```sh
PAPERCLIP_EVAL_MAX_CAMPAIGN_COST_USD=12 \
  PAPERCLIP_EVALS_ROOT=/path/to/paperclip-evals \
  pnpm --filter @paperclipai/paperclip-runner report:runner-live-evals

# Run two scheduled native Codex executions only.
PAPERCLIP_EVALS_ROOT=/path/to/paperclip-evals \
  pnpm --filter @paperclipai/paperclip-runner report:runner-live-evals -- \
  --candidate codex-luna --limit 2
```

GitHub-hosted live campaigns additionally require the default branch, an
allowlisted numeric actor ID, the protected `runner-e2e-paid` environment, and
an explicit repository variable before scheduled runs are enabled. Manual
dispatches accept the same candidate, case, and execution-limit selectors. The
paid job uses the reviewed RunsOn Fleet label when `RUNNER_E2E_AWS_ENABLED=true`
and otherwise stays on `ubuntu-latest`. Uploaded reports contain redacted
observations and trace digests, not raw provider
frames, prompts, credentials, tool arguments, or hidden reasoning.

The AgentCore proof-of-concept uses an AWS CLI v2 profile to provision a
dedicated invocation role and scoped resources. Its local mode-`0600` metadata
file contains no access keys; probes assume short-lived STS credentials and
clear them after use. Validate locally, provision or inspect the stack, run the
bounded lab/smoke, and tear it down explicitly with:

```sh
pnpm --filter @paperclipai/paperclip-runner test:aws-agentcore-provisioning
pnpm --filter @paperclipai/paperclip-runner aws-agentcore:provision -- --dry-run
pnpm --filter @paperclipai/paperclip-runner aws-agentcore:provision
pnpm --filter @paperclipai/paperclip-runner aws-agentcore:probe
pnpm --filter @paperclipai/paperclip-runner aws-agentcore:lab
pnpm --filter @paperclipai/paperclip-runner smoke:capability:aws-agentcore
pnpm --filter @paperclipai/paperclip-runner aws-agentcore:destroy -- --yes
```

To admit the hosted direct-eval workflow, provision with the account-local
GitHub Actions OIDC provider and keep the default exact repository and protected
environment binding:

```sh
pnpm --filter @paperclipai/paperclip-runner aws-agentcore:provision -- \
  --aws-profile paperclip-dev \
  --github-oidc-provider-arn arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com
```

This adds only `repo:paperclipai/paperclip:environment:runner-e2e-paid` as a
web-identity subject on the scoped invocation role. The generated nonsecret
profile records that role as both the local invocation role and the hosted
execution role.

Provisioning can incur Bedrock, AgentCore Runtime/Memory, storage, and private
networking charges. Provisioning refuses to modify a colliding stack unless its
Paperclip ownership tags and template description match. A verified
`ROLLBACK_COMPLETE` stack still requires `--replace-failed-stack` plus an
interactive confirmation (or `--yes`) before it can be deleted and recreated.
Destruction requires `--yes` and refuses to remove a stack with an active
recorded lab unless `--force` is also supplied.

## Package-owned commands

| Command                                                 | Purpose                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `build`                                                 | Compile the TypeScript public surface, Rust workspace, and browser devtool.                                                                 |
| `typecheck`                                             | Check TypeScript, Rust, generated schema sources, and browser types.                                                                        |
| `test`                                                  | Run Rust/TypeScript fixture, supervisor, fake-driver, live/replay, and boundary tests.                                                      |
| `check:forbidden-imports`                               | Reject TypeScript imports and Cargo path dependencies that cross into Paperclip core.                                                       |
| `check:tracked-imports`                                 | Reject tracked imports and `package.json` entry points that only resolve against untracked files, so a clean checkout of any commit builds. |
| `check:numbered-milestones`                             | Reject numbered construction-milestone names in tracked package paths and source.                                                           |
| `check:package-boundaries`                              | Enforce the acyclic runtime/testing/eval dependency and manifest boundary.                                                                  |
| `check:clean-consumers`                                 | Pack the runner and install its root, evals, and testing exports in a clean consumer.                                                       |
| `test:eval-slice`                                       | Run the credential-free eval bundle, scoring, and behavior/fault slice.                                                                     |
| `test:runner-workflow-evals`                            | Run the deterministic provider-neutral workflow matrix.                                                                                     |
| `report:runner-workflow-evals`                          | Validate deterministic fail-closed results and write JSON, Markdown, JUnit, and GitHub-safe reports.                                        |
| `report:runner-live-evals`                              | Execute the paid provider schedule and render its immutable attempts with the canonical `paperclip-evals` HTML grid.                        |
| `report:runner-chaos-evals`                             | Write the credential-free eight-scenario chaos schedule.                                                                                    |
| `test:aws-agentcore-provisioning`                       | Validate the AgentCore template and wrapper safety contracts without provisioning.                                                          |
| `aws-agentcore:provision` / `probe` / `lab` / `destroy` | Manage the scoped AgentCore proof-of-concept lifecycle.                                                                                     |
| `smoke:capability:aws-agentcore`                        | Exercise the qualified AgentCore profile through the capability harness.                                                                    |
| `check:conformance-parity`                              | Require byte-for-byte equivalent Rust and TypeScript tracer output.                                                                         |
| `check:replay-goldens`                                  | Require all reducer snapshots and cross-language summaries to match checked goldens.                                                        |
| `check:replay-parity`                                   | Run TypeScript and Rust against the same Replay fixture summaries.                                                                          |
| `check:browser-tokens`                                  | Reject component-local visual literals and require the standalone token layer.                                                              |
| `docs:validate`                                         | Validate local documentation links.                                                                                                         |
| `trace:conformance`                                     | Run the Rust mock-core tracer, print the stable result, and exit.                                                                           |
| `trace:conformance:typescript`                          | Run the TypeScript reference tracer directly.                                                                                               |
| `replay:fixture`                                        | Validate and reduce a fixture to a final snapshot.                                                                                          |
| `trace:local-runner`                                    | Run one native local session through the Rust runner and fake harness.                                                                      |
| `trace:codex`                                           | Run the mock core with a real, local skillless Codex app-server session.                                                                    |
| `demo:live-console`                                     | Start the package-local HTTP/SSE server with server-only Codex authentication.                                                              |
| `console:live-console`                                  | Start the standalone browser devtool with the Live console on `127.0.0.1:4180`.                                                             |
| `console:sdk`                                           | Start the public-SDK reference console and mini consumer on `127.0.0.1:4181`.                                                               |
| `test:sdk`                                              | Run targeted browser-client, reducer-projection, and React component contract tests.                                                        |
| `test:browser:sdk`                                      | Exercise both consumers with the fake driver, keyboard/a11y checks, reconnect/replay, measurements, and screenshots.                        |
| `record:sdk:codex`                                      | Run both public consumers against a safe real Codex session and capture live screenshots.                                                   |
| `check:capability-contract`                             | Verify the generated capability, legacy MCP, and eval traceability contract.                                                                |
| `check:semantic-contracts`                              | Verify the provider-neutral semantic tool contract is current.                                                                              |
| `trace:live-runner`                                     | Run the real runnerd/Codex semantic loop against the mock control plane.                                                                    |
| `demo:scenarios`                                        | Start the Capability scenario explorer over the mock control plane on `127.0.0.1:4183`.                                                     |
| `console:issue-thread`                                  | Start the Paperclip-style issue thread on `127.0.0.1:4184`.                                                                                 |
| `test:scenarios`                                        | Run the scenario index, run-artifact, parity, explorer component, and route tests.                                                          |
| `test:browser:scenarios`                                | Exercise both the scenario explorer and issue-thread browser contracts.                                                                     |
| `browser:dev`                                           | Start the standalone live/replay browser devtool.                                                                                           |
| `test:browser`                                          | Exercise static replay and live scenarios, then capture temporary screenshots under ignored test output.                                    |
| `verify`                                                | Run the complete deterministic Conformance through SDK acceptance sequence.                                                                 |
| `verify:rootless`                                       | Extract Debian/Ubuntu browser libraries without root, then run `verify`.                                                                    |

## Navigate

- [Architecture and dependency boundary](docs/architecture.md)
- [ADR 0001: runner and testing package boundaries](docs/adr/0001-runner-testing-eval-package-boundaries.md)
- [Tutorial index](docs/index.md)
- [Conformance hand-run tutorial](docs/tutorials/conformance-standalone-tracer.md)
- [Replay hand-run tutorial](docs/tutorials/replay.md)
- [Local runner hand-run tutorial](docs/tutorials/local-runner.md)
- [Local protocol reference](docs/local-runner.md)
- [Durable transport reference](docs/durable-recovery.md)
- [Codex skillless Codex tutorial](docs/tutorials/codex.md)
- [Codex skillless Codex driver reference](docs/codex-driver.md)
- [Live console protocol/server tutorial](docs/tutorials/live-console-protocol-server.md)
- [Live console protocol/server reference](docs/live-console-protocol-server.md)
- [Live console tutorial](docs/tutorials/live-console.md)
- [Live console reference](docs/live-console.md)
- [SDK console tutorial](docs/tutorials/sdk-console.md)
- [SDK browser SDK reference](docs/sdk.md)
- [SDK component decision record](docs/design/sdk-component-decisions.md)
- [Capability semantic catalog and authorization](docs/capability-semantic-catalog.md)
- [Capability live runnerd/Codex loop](docs/capability-live-runnerd-codex.md)
- [Capability issue-thread UI](docs/capability-issue-thread-ui.md)
- [PRP compatibility/versioning policy](docs/protocol-compatibility.md)
- [Adding a harness and permission-mode requirements](docs/adding-a-harness.md)
- [PRP v1 expressiveness audit](spec/prp-v1-expressiveness-audit.md)
- [Cumulative end-to-end tutorial](docs/tutorials/end-to-end.md)

Codex adds the package-local real-model reference driver, Live console adds the
package-local browser console, and SDK extracts a reusable public SDK plus
two standalone consumers. Runtime production Paperclip integration remains
deferred; the App-owned production conformance adapter is test-only.

The SDK reference console opens in direct chat mode. Enter a normal prompt,
then open the protocol inspector to review events and reducer state. Expand a
Terminal row and its nested **Debug details** disclosure to inspect every
canonical event retained for that command. The header marker `🖇️ v0.1.2`
identifies the current console iteration.

`create_task` accepts an optional initial `status` of `backlog` or `todo`. Use `backlog` when the user wants a saved task or plan without execution: assignment and the initial plan are committed without scheduling a wake, even when dependencies are already complete. Omitting status preserves immediate delegation (`todo`, or `blocked` for unresolved dependencies).
