# Runner E2E fixture authoring

The fixture catalog is executable production-contract data. Keep it small,
typed, deterministic, and free of raw credentials.

## Suites and matrices

A `RunnerSuiteFixture` declares one durable testing purpose: stable ID, label,
description, profiles, environments, cases, expected size, and definition or
ranking metadata. Its execution IDs are globally prefixed as
`<suite>.<profile>.<environment>.<case>`. Add a new suite when the testing
purpose or desired cross-product differs; do not inflate an existing suite with
unrelated dimensions.

The suite definition fingerprint is historical comparison metadata. Any
profile, model qualification, environment, task, or ranking-snapshot change
must change that fingerprint automatically so the dashboard can annotate the
boundary instead of silently joining unlike totals.

## Agent profiles

Add `RunnerProfileFixture` entries in `catalog.ts`. A profile declares:

- a stable ID and searchable groups;
- legacy or native generation;
- adapter/provider and required credential;
- a model imported from its adapter constant or qualified runner profile;
- supported environment IDs;
- expected runtime metadata; and
- an agent payload factory.

Do not duplicate model IDs, qualification decisions, CLI versions, or runner
artifact rules. Codex profiles import `DEFAULT_CODEX_LOCAL_MODEL`, OpenCode
profiles import `QUALIFIED_OPENCODE_MODEL`, and ACPX profiles import
`QUALIFIED_ACPX_PROFILES`. Add or qualify models at their owning production
source first.

OpenRouter breadth profiles are generated from `openrouter-models.json`, not
written by hand. That reviewed snapshot must contain exactly five unique,
available, tool-capable models with rank, canonical ID, display name, supported
parameters, source URL, capture time, and verified content hash. Refresh it
manually with `pnpm test:e2e:runner:models:update`; nightly campaigns never
change fixture definitions.

Agent `adapterConfig.env` values must be `{type:"secret_ref", secretId,
version:"latest"}` objects supplied to the factory. A fixture source containing
a raw secret-looking value is rejected by catalog validation.

The manual Grok subscription profile uses `GROK_AUTH_JSON` as an explicit login
fixture. It does not put this credential in agent configuration or substitute an
API key. Setup seeds a new company-scoped Grok home inside the disposable instance
with mode 0700 and an exclusive mode-0600 auth file. Setup rejects redirected,
occupied, or nonisolated homes. Production runner discovery and refresh operate on
that company login; teardown destroys it after the remote environment is removed.
This fixture tests subscription execution, not the interactive browser login flow.

## Environments

An `EnvironmentFixture` declares driver/provider, credential requirements,
attempt deadline, lifecycle behavior, expected execution target, and a payload
factory validated by the shared environment schema.

The local environment is instance-managed: company creation ensures it exists,
and the public API intentionally rejects a second local environment. The setup
registry therefore discovers that row through the public environments API.
This still provides full isolation because every cell starts a new Paperclip
instance and database.

Daytona creates sandbox environments through the public API. The core fixture
keeps `reuseLease:false` and `runnerLifecycleMode:"per_turn"`. The dedicated
warm-continuity fixture uses `reuseLease:true` and
`runnerLifecycleMode:"warm"`; its distinct `configurationKey` is part of the
suite fingerprint even though both fixtures report `environmentId:"daytona"`.
Keep short provider cleanup backstops, a Daytona secret reference, and an
immutable image digest. Teardown
must delete the environment with reusable-lease destruction and must fail the
cell if cleanup cannot be confirmed. Keep CPU, memory, and disk explicit: lease
metadata and the per-test public-list-price runtime estimate depend on that
pinned billable resource shape. Changing it requires updating billing tests and
reviewing the versioned Daytona rates in `billing.ts`.

## Usage and billing data

Do not add fixture-authored token or dollar expectations. The live harness
reads usage from selected public heartbeat-run records and records coverage per
run. Provider-reported dollars remain distinct from runtime estimates. A zero
or missing native usage payload is `unavailable` unless a real token-bearing
receipt or provider cost proves otherwise. New execution environments must
provide lease/resource metadata for a runtime estimate or explicitly remain
`unavailable`; never infer that missing billing data means free execution.

Future providers (SSH, E2B, Modal, Cloudflare, Kubernetes, Novita, exe.dev)
should implement the same setup/probe/cleanup contract before being added to a
matrix. Unsupported profile/environment combinations belong in
`supportedEnvironments`, not in ad hoc test conditionals.

## Task cases and matchers

A `RunnerTaskFixture` owns a work mode, a typed flow, expected run count,
nonce-based title/prompt/marker factories, per-environment attempt deadlines,
deterministic matchers, and expected terminal state. Single-turn prompts should
make one bounded request with observable output and no nondeterministic judging.
The `plan_revision_acceptance` flow must also provide revision-request and Plan
marker factories. `question_resume_completion` must define the deterministic
browser answer and prove exactly two successful runs with no pending
interaction. `plan_approval_completion` must target the exact two-step
canonical Plan revision, capture its pending UI, approve in the browser, and
prove exactly two successful runs. `warm_three_turn` provides exactly two
browser follow-up messages, preserves one project/execution-workspace scope,
verifies host file contents after every turn, and finishes within three
ten-minute turn deadlines. Native turns 1 and 2 include an actionable human review in the completion report's `attentionRequests`. Paperclip creates the review gate from that report. An explicit question-tool wait yields the turn and suppresses its final prose, so it is not interchangeable with this completion-review fixture. Turn 3 reports Done without another review.

Every selected case runs in its own isolated Paperclip process, and independent
cases may run concurrently. Follow-up turns inside one case retain their shared
task state. Each case creates and tears down its own company, secrets,
environment selection, agent, and browser-created task. The current plan case
proves three runs on the same issue: publish a two-step Plan,
request a three-step revision through the UI, and accept the exact new revision
through the UI before verifying implementation and Done.

The matcher union supports message exact/contains/regex/ordered checks, issue
and run state, runtime/environment metadata, files, artifacts, JSON paths, and
JSON Schema. The initial cases use normalized `message_contains` plus state,
runtime, and environment assertions; the plan flow additionally verifies
canonical document revision IDs, bodies, step counts, interaction targets, and
visible previews. Add matcher behavior and credential-free tests together.

Adding a task expands its suite's matrix. Update the suite's intentional size,
the complete-catalog size, and credential-free unit tests in the same change.
Paid tests never silently skip a missing credential or unsupported artifact.

## New Paperclip object fixtures

The explicit-only `lifecycle-baseline` suite reuses this registry and existing
continuation, chat and governed-action flows. Its narrative pairs require actual
agent/run-attributed comments or exact visible responses. See
[the live baseline contract](LIFECYCLE-BASELINE.md) for selectors and proof boundaries.

Register new objects in `live-fixtures.ts` with explicit dependencies in
`FixtureRegistry`. Setup must use a public API. Teardown runs in reverse order
and is invoked after partial setup failures. Direct database writes and private
test-only runner endpoints are prohibited.

The expected dependency shape is:

```text
company
└── encrypted secrets
    └── environment
        └── agent
            └── browser-created task
```

Projects, goals, apps, and configuration fixtures can be inserted into that
graph without changing the launcher. Keep returned fixture state to IDs and
sanitized metadata; never retain raw secret values.

## Required checks

Run before a fixture change is reviewed:

```bash
pnpm test:e2e:runner:unit
pnpm test:e2e:runner:typecheck
pnpm test:e2e:runner -- --list
```

Then run the narrowest paid cell that exercises the fixture. A full matrix is a
manual or scheduled campaign, not a PR requirement.


## Persistent chat fixtures

`chat-cases.ts` defines the eight-case `agent-chat` suite; `chat-flow.ts` drives the
production composer, plan revision/approval controls, questions, reset command,
and project cards. Keep its 28 local cells intentional. `expectedRunCount`
counts provider turns, including cancelled and handed-off task runs, but excludes
synthetic `/new` runs. Assertions must inspect all company runs because ordinary
issue lists exclude the source conversation. `assertChatHandoff` rejects missing
projects/plans, chat children, wrong assignees, and execution before plan commit.

Retained `api-state.json`, `chat-handoff.json`, and plan-revision evidence
include persisted comments, session generations, run context and logs, project
workspaces, task documents, and ordering. They pass through the normal sanitizer.
Screenshots are allowlisted to the exact disposable agent chat. Cleanup cancels
all active runs in the isolated company, including handed-off work; usage from
failed and cancelled runs must not disappear from campaign totals.


Warm three-turn continuity grades the exact workspace file after each turn,
task completion, and sandbox/session identity. It also requires a visible
persisted final reply with each turn marker once and in order. It does not
grade exact final-reply wording; the hello
and continuation fixtures retain those exact-response checks. This separates
workspace persistence failures from model response-format variance.

`chat-hardening.ts` adds the explicit-only `agent-chat-hardening` journeys. Use
the ordinary public APIs to seed source documents and blockers. Keep the answer
out of the user's status/review request. Grade the exact source values, latest
blocker, preserved task identities, worker-authored output, and real executions.
The status request asks for JSON so the grader can distinguish the current
blocker from a historical mention and compare active-run count separately from
task status. The request must not reveal those expected values.
Capture the source after seeding and compare every field in the public issue
update contract, plus labels, dependencies, and dedicated-endpoint settings.
Derived inbound references may change when the chat legitimately cites a task.
The lost-acknowledgement probe may interrupt only the fixture browser's own
comment request after the real server has committed it. Retain its request ID
and replay that same request through the public API after restarting the server.
Never fabricate tool results or repair task state after a failed assertion.

`chat-stories.ts` seeds an ordinary file wait in the isolated agent's actual
home workspace; native Codex intentionally cannot see arbitrary host temp files.
The observed run workspace must match the fixture location. This is a deterministic interruption
boundary. The real provider command writes the readiness file and waits at most
two minutes. The harness must persist the next browser message while the same
run is active before supplying the brief. Always release the wait in `finally`.
Save boundary observations independently of the final outcome. The final answer
must recover a brief reference absent from both prompts; the revision oracle
also reads the actual conversation plan. Fixture setup never enables native API
tools for this suite. Do not describe its prepared-agent settings case as a
production onboarding qualification.

The `agent-chat-qualification` local fixtures use public APIs to seed two workers
and a task with a saved plan, or read-only tasks with contradictory historical
comments. Ordinary Node file waits in the isolated agent workspace establish
observable active execution; no provider output or database outcome is fabricated.
A worker-crash case sends SIGKILL only to a positively identified running native
worker PID, then uses the production Retry button. Each gate is released in a
finally block. Source facts and boundary state are retained with the attempt.
The lifecycle suite also includes two legacy disposition-repair probes. Their
first provider turn intentionally omits task disposition, and their second turn
must be an automatic, causally bound repair that records completion. They use
public task comments/status APIs and run-detail evidence; no private runtime
hooks or database mutations are used by the fixture.

The explicit-only `extended-harnesses` suite uses five bounded journeys for each
pending ACP candidate on local and Daytona. Candidate profile metadata includes
the exact authenticated discovery choice without promoting it to a product
default. Its file case anchors the task to a public project workspace, validates
the model's claimed result by reading the actual final bytes, and also exercises
remote copy-back. Keep candidate admission scoped to the selected model and the
isolated operator environment; ordinary agent configuration must not enable it.

## Persistent agent files

The `instruction_persistence` flow uses production managed storage and public file
APIs. The browser creates a supporting file, then a real agent edits its registered
AGENT_HOME with ordinary filesystem tools. Independent oracles verify instructions,
nested text, binary download bytes, and a stopped-run save receipt without new
revision history. The harness restarts the server and creates a fresh browser task
without disclosing the saved nonces. Its readback oracle downloads and verifies an
attachment's bytes and SHA-256, rather than accepting a filename or model claim.
A third task uploads a ready attachment and waits in an ordinary bounded shell
command while the board changes the current file through the public API. Stopped
cleanup must preserve the original candidate as a conflict. The browser reviews
current and incoming files and applies the run edits against the reviewed current
directory hash. All three tasks' runs count toward billing and teardown. The suite
is explicit-only. No private control-plane hooks or direct database writes are used.

## Pi native boundaries

The explicit-only `pi-native` suite has four local and three Daytona candidate
cells, with no automatic retries. The remote suite excludes automatic deny-all
because its initial native file read is itself denied. `native-questions` answers the real runner-owned Pi select, confirm, input
and editor tool through four durable browser cards, reloading before every answer.
Undisclosed text and independent workspace JSON prove delivery to the same live run.
Pi's SDK cannot distinguish negative confirmation from dismissal; the expected
result is explicitly `negative_or_cancelled`, not proof of cancellation.

`agent-files-fresh-run` writes a hidden nonce through native file tools to the
registered AGENT_HOME, requires a stopped-run save receipt and public managed-file
readback, then restarts the server and verifies exact bytes from a fresh task. An
attempted write to an unassigned isolated sibling path must fail without creating
a file. `restrictive-denial` requires a correlated failed native write and absent
file under `deny-all`. All runs count toward spend and teardown. Browser reload
is reconnect evidence only; these cases do not establish provider-death recovery.
They use public product APIs, real browser answers, and ordinary isolated files;
no database writes, private hooks, or fabricated provider results are allowed.

## Copilot native protection

The explicit-only `copilot-protection` suite has two cases on local and Daytona,
each with one run (120s
provider timeout, 300s attempt budget). `native-permission-deny-write` denies one
exact native edit through its browser card, waits for the delivered rejection and
failed tool, then cancels through the public run API. Its expected outcome is a
cancelled run and an unfinished task, not successful task completion.
The retained `paperclip.e2e.copilot-denial-settlement.v3` proof separates the exact
provider terminal from the audited controller Stop. It records either
`provider_cancelled_or_interrupted` or `provider_completed_observed_before_stop`.
The latter requires the exact terminal row to be returned by the operator API
before Stop dispatch. The fixture awaits retention of its scoped row-hash receipt
before sending Stop, then matches that receipt against the final durable rows.
The same normalized session/source stream and a later source sequence than the
failed edit are required. A fixed 2s observation window, inside the existing case
deadline, allows natural completion. A normal terminal first seen after Stop is
insufficient evidence. Database createdAt is transaction-start metadata; it cannot
prove that an event committed before Stop acknowledgement. It cannot establish active-turn cancellation;
a cancelled/interrupted terminal also does not by itself prove Stop reached active
work. Dedicated cancellation coverage must retain its active-operation evidence.
Missing, ambiguous, failed or foreign terminals and incomplete Stop receipts fail.
This distinction does not regrade earlier failed attempts. The case rejects
extra native operations/runs and observes the absent target through process
retirement. Filesystem event loss or an unexplained parent-directory timestamp
change makes no-effect coverage incomplete; stat polling alone cannot pass.

`attached-async-settlement` starts a fixed finite command with explicit async mode
and `detach:false`, then asks the model to attempt immediate completion. A one-shot
private socket in the tested environment accepts only the fixture nonce, never an executable or command;
the test owns/reaps a predeclared child and records its actual exit before releasing
the provider-launched client. The independent marker, client retirement, native shell
linkage and actual durable turn terminal must agree. Fixture resources close in a
finally block. This establishes the tested finite attached-command behavior, not all
background modes or detached-process settlement.

Both cells consume bounded, origin-correlated `copilot_tool_evidence_v1` notices
persisted through the ordinary run-event API. Missing, redacted, ambiguous or
explicitly incomplete notices fail qualification. Old runtime artifacts therefore
cannot qualify these cases. No prompt/title substitutes for native input, no raw
command or arbitrary tool input is added to production event payloads, and no private
runner hook or database write is used. The cases are registered but require a newly
built source/pack and separately authorized paid execution before claiming Product
qualification. Full restrictive-workflow completion remains separate: the negative
case never auto-approves an uncorrelated later MCP permission.

The Copilot protection cells explicitly select `per_turn` lifecycle. Their read-only
process journal accepts the API runner PID only after checking its OS start time,
process group, exact run ID argument and `per_turn` argument; it never treats a
retained warm daemon as a leaked per-run process or signals an API-provided PID.
Directory-watch coverage also rejects parent device/inode replacement or removal.


The manual `cursor-native` suite has four cases on each of local and Daytona with
one expected provider run each and a 120-second provider deadline. Browser
choices, rejection feedback, native origin/decision receipts, workspace checks
and provider retirement are independently checked. Failed or missing cleanup
assertions fail the final report even if the native interaction passed. No
native callback, private-HOME artifact export, or paid qualification is inferred
from a semantic question or plan result.


### Remote native proof scope

Remote native cells require the exact authenticated lease, run, immutable image
and executable bindings documented in [the runbook](README.md#remote-native-evidence-and-warm-continuation).
Action publication follows observer readiness and a saved baseline. The observer
seals before environment destruction and retains file bytes on the host; no
post-deletion RPC or host-copy-back evidence may satisfy remote no-effect or
retirement checks. Runtime-internal files are an explicit scoped exclusion.
`human-permission-denial` requires native request/tool correlation, the browser's
exact Decline, delivered denial and failed write, and unchanged file evidence
through retirement. All normal project and company boundaries apply.

Cursor and Copilot may exempt a bootstrap read only when every native notice for
that completed tool origin carries the single-path attestation matching the
observer's exact random action file. The passive projector derives this digest
from one explicit scalar native input path, rejects ambiguous/multiple paths,
and checks subsequent input/location updates for changes. Durable canonical
execution receipts must match the same run, turn, execution identity, status,
and order; any explicit canonical target must agree. Missing or conflicting
attestations fail qualification. PRP retains only the first location and terminal
updates may omit it, so canonical targets alone cannot prove bootstrap ownership.
Neither tool titles nor output text supplies path evidence.

Denial ordering uses canonical request, decline-resolution, delivery, failed-edit
and terminal source sequences. Sample checkpoints retain the exact run/turn/source
cursor. File samples and continuous-watch coverage compare only observer-local
times. Provider emission, browser click and server persistence clocks are never
compared to each other. Final remote samples use the sealed, independently verified
process-retirement receipt; their timestamps are not relabeled as host time.
This denial case does not qualify Stop during a definitely pending native request.
That active-turn cancellation boundary needs a separate live case. The attached
async-command oracle is unchanged by this denial-only correction.

### Correlated native Stop API

The board-only `POST /api/heartbeat-runs/:runId/cancel` accepts an optional
`cancellationRequestId` UUID for native runs. Company access checks still apply.
The server reserves it under the run-row lock before dispatch, uses
`native-cancellation:<UUID>` as the durable intent ID, and returns HTTP409 for
an earlier or different caller intent, an earlier uncorrelated Stop, or a
terminal run without that same reserved intent. Malformed UUIDs return HTTP400.
Repeating the same UUID from the same board actor is idempotent. A different
actor receives HTTP409; local trusted board uses the `local-board` user ID.
Default clients may omit the field; they preserve and join an existing reserved
intent rather than overwrite it.

The denial fixture generates its UUID before observation, retains it in
`paperclip.e2e.copilot-pre-stop-observation.v2`, and requires the same intent in
the response and final `paperclip.e2e.copilot-denial-settlement.v3` receipt.
It refuses a non-running controller or existing Stop marker before dispatch.
The completed-provider branch still requires a running controller that this
request can stop; it does not accept a no-op Stop of an already terminal run.

## Definitely-active native Stop

`native-active-stop` / `pending-permission-stop` has four explicit-only cells:
Cursor and Copilot, each local and Daytona. Its `native_active_stop` flow retains
`paperclip.e2e.native-active-stop-pending.v1` from the public API while exactly one
native permission remains pending, the exact controller run is running, and no
Stop or answer marker exists. The receipt independently binds native session,
normalized session, turn, source instance, request/tool IDs, source sequences and
canonical row hashes. An awaited artifact write and fresh pending reread precede
Stop dispatch; process-monotonic timestamps describe only these local observer
boundaries. Remote provider clocks and database transaction timestamps never
establish that ordering. The atomic caller UUID fence rejects an earlier racing
Stop instead of borrowing its acknowledgement.

`paperclip.e2e.native-active-stop-settlement.v1` accepts only
`pending_permission_cancelled`: explicit-cancellation request closure with
`replayAllowed:false`, then one exact `turn.cancelled`, plus the same scoped
caller-owned native Stop acknowledgement. Missing, duplicate, foreign, failed,
interrupted or normal terminal evidence fails. Only after this proof does the
fixture attempt a stale public answer, requiring HTTP409 and an unanswerable
browser card. It retains one cancelled run, issue `in_progress`, exact target
absence through continuous observation, and all observed owned descendants
retired. Local files require four fresh observations through cleanup. Daytona
instead retains two live snapshots (baseline and pending) plus one automatic
owned-process-retirement seal, with a continuous zero-mutation watcher and the
same complete root/descendant journal. Suite version 2 retains this as
`paperclip.e2e.native-active-stop-remote-retirement.v1`; it explicitly records
`filesystemAfterRetirementObserved:false`. The per-turn observer seals itself
when the owned tree retires, before the sandbox is released. Reading that receipt
later is not a fresh post-UI or post-cleanup filesystem observation. Relabeled,
reused, missing or out-of-order samples fail. The stale-answer and rendered UI
checks remain separate, followed by fresh API cancellation/no-extra-run checks
both after UI and in cleanup. Unproven cleanup fails independently. Only fully
attested bootstrap reads may precede the one tested operation; alternate operations or attempts are rejected.

The existing `copilot-protection` denial remains distinct: rejecting a permission
before Stop does not exercise this pending-callback boundary. This new suite has
pure calibration and wiring tests, not a paid qualification result. Provider
process death is not simulated by substituting the chat runner-worker crash hook.
