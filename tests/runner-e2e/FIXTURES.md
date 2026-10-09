# Runner E2E fixture authoring

## Connection creation fixtures

See [PROVIDER-CONNECTIONS.md](PROVIDER-CONNECTIONS.md) for the explicit-only
`provider-connections` suite, local/staging target ownership, dedicated browser
profiles, credential handoffs, private evidence, and cleanup contract.

The [public MCP journeys](PUBLIC-MCP.md) reuse the fixture registry with a real
authenticated browser session. `RunnerApi.setBrowserSession` binds that session
to API calls, including encrypted secret provisioning via Node fetch. OAuth
setup stays outside model context. The external assistant receives the catalog
from `tools/list` and the shipped workflow skills; its calls execute against the
real SDK transport. Client-side loss of a successful response is the sole fault
injection in the uncertain-retry case. Task/run/document REST reads own grading.

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

Pi native definition 21 supplies one ordinary JSON write with the nonce followed
by exactly one LF, then asks for a complete native read. The independently
checked outcome remains 33 bytes, saved through the public managed-file API
and copied into a fresh task after controller restart. Missing LF, extra LF,
literal escapes, CRLF and stale values all fail. The cross-root denial, protected
parent seed, permissions, deadlines and zero automatic retries remain required.
Both runs also require a completed, untruncated native-read receipt containing
the exact memory text and a withheld private-root target, and reject shell
execution. Named workspace reads and unrelated/bootstrap text cannot substitute;
Remote observer admission keeps the owned-run and active-lease checks. Its
existing readiness RPC verifies the pinned native daemon before installation;
legacy executionStage can remain preparing for a native run. Readiness and case
deadlines remain unchanged.
The first Sonnet measurement passed the byte/restart checks but used a shell read
in the fresh task. Its original grade remains preserved.
The user approved Sonnet 4.6 through OpenRouter as the explicit Pi qualification
model; production model selection stays caller-controlled. Earlier DeepSeek
attempts and their fingerprints remain historical evidence and do not qualify
this new model/fixture combination.

The explicit [stock-harness suite](STOCK-HARNESS.md) wraps existing profiles with
`productionDefaultHireProfile`: omit only `instructionsBundle` so the public
hire route loads the shipped default, while preserving runtime, permissions,
auth, skills, and managed secret references. Do not replace this with a fixture
copy of the default manual. Public receipts check the exact independently
specified bundle before provider execution and again during cleanup, along with
both budget hard stops and actual legacy invocation prompts. Missing evidence
fails closed. The definition fingerprint includes the helper, graders, journey
sources, live fixture, and execution integration; editing those sources changes
the suite revision automatically.

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
ten-minute turn deadlines. The ordinary warm fixture uses managed instructions,
updates AGENT_HOME each turn, and verifies memory, an unchanged 8 MiB binary and
a deletion through public file APIs. Native turns 2 and 3 must copy/hash only the
changed memory file, with a saved receipt and the same provider PID. Journal and
Git stress fixtures retain fixed external bundles as controls. Keep the stable-PID
oracle strict; `instruction-persistence` also covers cold restarts and quota handling.
The explicit `rich-acp-warm-continuity` fixture uses the workspace-only prompt:
ACP providers retain their unchanged AGENT_HOME and must preserve the same native
session, runner instance, provider session, PID, and process start fingerprint.
It does not request personal-file edits, because changed ACP agent files require
provider retirement before collection. Pi's separate `agent-files-fresh-run`
case retains changed-home save and fresh-task restoration coverage. This split
does not weaken the stable-process oracle or change the Codex checkpoint fixture.

Native turns 1 and 2 include an actionable human review in the completion report's `attentionRequests`. Paperclip creates the review gate from that report. An explicit question-tool wait yields the turn and suppresses its final prose, so it is not interchangeable with this completion-review fixture. Turn 3 reports Done without another review.

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

## Prompt-only task title fixtures

`task-titles.ts` defines a bounded ordinary writing request and an independent
title oracle. Its `single_turn` cases leave the title field empty or supply an
explicit control title. The harness captures the exact browser creation response
instead of searching by a title that the agent may already have changed. It
never patches the title itself. Normal production instructions own the early
naming behavior; fixture prompts and agent instruction bundles contain no naming
hints. Existing company/secret/environment/agent registry dependencies are reused,
with 500-cent company and agent budgets and normal instance teardown.

Keep the call input, successful result, execution receipt, saved task, and
agent/run-attributed audit correlated. Missing evidence must fail. The first-five
tool-call bound counts calls in the initial provider run, including discovery.
The title must describe API-key rotation without requiring one exact wording.
The control must retain its title throughout, not merely restore it at the end.
The source digest versions the grader and request in catalog metadata. See
[Automatic task titles](README.md#automatic-task-titles) for live selectors,
coverage limits, evidence, and calibration.

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

Definition 23 and Pi controls definition 10 confirm `/proc/<pid>` absence
separately when a proc read fails during Linux process exit. An existing
unreadable process, an unreadable absence check, identity drift, and incomplete
terminal evidence still fail. The observer retains closed causes for process
reads, stat shape, runtime binding and terminal sealing; it never retains raw
process arguments. Historical failed receipts remain failed.

The explicit-only `pi-native` suite has five local and four Daytona candidate
cells, with no automatic retries. The remote suite excludes automatic deny-all
because its initial native file read is itself denied. `native-questions` answers the real runner-owned Pi select, confirm, input
and editor tool through four durable browser cards, reloading before every answer.
Undisclosed text and independent workspace JSON prove delivery to the same live run.
Pi's SDK cannot distinguish negative confirmation from dismissal; the expected
result is explicitly `negative_or_cancelled`, not proof of cancellation.

`agent-files-fresh-run` supplies one native write argument object whose content
is the hidden nonce plus exactly one final LF. The agent replaces only the
AGENT_HOME prefix in the supplied path; it preserves the JSON newline escape in
the content argument, then reads the complete file once. A missing LF, literal
backslash-and-n, repeated write, or claimed success cannot satisfy the independent
byte oracle. The flow uses native file tools in the registered AGENT_HOME,
requires a stopped-run save receipt and public managed-file
readback, then restarts the server and verifies exact bytes from a fresh task. An
attempted write to an unassigned isolated sibling path must fail without creating
a file. `restrictive-denial` requires a correlated failed native write and absent
file under `deny-all`. All runs count toward spend and teardown. Browser reload
is reconnect evidence only; these cases do not establish provider-death recovery.
They use public product APIs, real browser answers, and ordinary isolated files;
no database writes, private hooks, or fabricated provider results are allowed.

### Pending native controller restart

`native-pending-controller-restart` restarts the public controller while one Pi
input callback remains unanswered. It requires the same durable interaction,
request, live run, native session, turn and producer before and after restart.
For local execution, the public run's exact PID, process group and start identity
must identify an already-observed durable runner under this controller. The test
preserves only that runner tree during restart, checks the same live identity
afterward, and keeps the old process owner for complete final cleanup alongside
the replacement controller. Other controller children are retired normally.
Remote execution does not infer local process authority from remote PIDs.
Only then does the browser submit previously undisclosed text. One durable
resolution, one original successful turn and independently read exact workspace
JSON prove delivery. A replacement run, replay, cancellation, expiry, rewritten
request or merely reloaded browser cannot pass. Full states and PRP identities
stay in private snapshots under the existing publication allowlist.
The local runner's unique `turn.submitted` receipt may precede assignment of the
provider turn ID. The oracle accepts that missing ID only before the single
matching `turn.started` and request creation, with the same session and producer
and increasing durable/source sequence numbers. Later missing or changed turn
identities still fail.

### Pi file editing and registered artifacts

Pi's `extended-harnesses/file-edit-validate` seeds exact bytes before startup and
requires one native edit lifecycle followed by exactly one successful native
bash execution with the exact nonce-bound byte-validation command as its
projected title and a validation marker. A marker-only echo cannot pass. Final bytes must
match the fixture. The Pi task prompt explicitly forbids additional shell calls,
including metadata commands and repair attempts. It supplies the expected post-edit
byte size and hash for registration. Extended definition 5 places the exact command in a
fenced Bash block so the production Markdown editor preserves its operators and
literal escapes. Definition 4's escaped-paragraph attempt keeps its failed grade.
Extra Bash calls fail the unchanged oracle even when the
edited file and downloadable artifact are correct. Extended definition 4 makes
Pi's artifact title equal the exact filename required by the shared registered
artifact check. Definition 3 attempts retain their original definitions and
grades; its Pi prompt requested a different title. The real
`register_deliverable` receipt, attachment metadata, publication activity,
visible task attachment and authenticated public download must all agree on the
file's bytes, hash, company, issue, agent and originating run. A file on disk or a
model completion claim cannot substitute for publication. Daytona additionally
requires the public run's finalized `nativeWorkspaceSync` descriptor, baseline and
final-host hashes, bound workspace and public environment lease to match this
run/company/environment/provider lease and remote root. The checked host bytes
come through production stage-in/copy-back; this is explicitly `product_copyback`
provenance, not a sealed guest observation or an independently recomputed whole
host-workspace snapshot. Downloaded artifact bytes remain independently checked.

Private `pi-file-seed.json`, `pi-file-observation.json` and `pi-file-evidence.json`
retain the seed, downloaded/workspace bytes, public publication receipts, checked hashes,
correlated tool identities and a before/after diff computed from independently
checked workspace bytes. This is not native diff presentation. The current
common tool projection omits raw arguments and reports typed `exitCode: null`;
the oracle checks the command title and completed lifecycle, without claiming raw
invocation arguments or a typed exit code. The sidecar converts Pi absolute file
locations into bounded workspace-relative display targets; the oracle requires
the exact relative filename, but that display value is not file-access authority.
Restoring raw arguments, typed exit code and native diff presentation remains a
capability follow-up.

Wrong or missing lifecycle, byte, registration, download or recovery evidence is
a candidate failure; transport/infrastructure failures retain the existing
harness classification. Positive and plausible-wrong/missing-evidence unit
calibrations do not count as paid qualification. All automatic retries stay zero.

`native-pending-provider-death` adds one real Daytona-only Product journey.
After the native input is publicly durable and still unanswered, the existing
owned remote observer admits the exact Pi child through its verified wrapper
parent, source-pinned closure files, executable inode, workspace, run/lease/session
ancestry and fresh PID/start-time checks. Pi overwrites Linux argv via
`process.title`, so the private receipt explicitly uses pinned-parent entrypoint
attribution and never claims original child argv. A pidfd targets only that child;
worker death, broad process-name matching and controller Stop cannot substitute.
The production bootstrap may name its held executable as `/proc/self/fd/3`
or `/proc/self/fd/7` in the wrapper argv. That form is admitted only when the
wrapper's corresponding descriptor and executable both have the exact sealed
snapshot Node inode. The guard and wrapper entrypoint paths remain exact.
Missing, foreign or other descriptor numbers fail before signalling.
Production may also stage the runner executable as a link to the image's
verified installation. The fault helper reads the resolved regular file, checks
that the named link remained unchanged, and still requires its pinned hash and
exact `/proc/<runner-pid>/exe` inode. Link replacement, missing targets and a
different executable fail admission. Linux calibration covers this installation
form as well as a copied runner.

The agent-memory fixture requires the nonce's UTF-8 bytes followed by exactly
one line-feed byte (`0x0A`). Its prompt states that byte contract in plain text
and provides the exact content as fenced JSON. Fenced task prompts use the rich
editor's Markdown paste path; filling the editor directly produces escaped
paragraph text instead of a code block. The issue API preserves literal escapes
in real multiline bodies and only recovers self-escaped line breaks in legacy
single-line bodies. Code fences and JSON escapes must survive both boundaries.
The prompt explicitly states that native write never adds a newline and that
complete native read preserves one when present. A credential-free probe of the
installed Pi 1.0.0 tools checks both a 32-byte value and the 33-byte value with a
final line feed; both write and read retain the exact supplied bytes.
The prompt orders one memory write, one complete native read, a separate expected
cross-root write denial, and then completion. Native paths use the exact current
absolute agent directory; shell-variable expansion is not assumed. An incorrect
memory result must be reported without claiming success. Native readback and the
managed-file API must retain the exact bytes across a new task and controller
restart. The byte graders remain unchanged.

Controller cleanup can admit a replacement group member only when its ancestry
belongs to a separately revalidated, continuously owned process. A recycled
numeric group, a changed PID/start identity, or any unowned live member still
fails cleanup before signaling. This rule is recorded in `pi-native` version 12.

The runtime itself must emit `runtime_request.expired` for the original callback
with `provider_process_lost` and `replayAllowed:false`, followed by native turn
failure. The permanent failed-terminal recovery projection must put the owned
issue in Blocked, proved through API and browser and retained through cleanup.
The original durable card must expire, retain zero answers and lose its browser
answer controls; any supersession must name the separate fallback card.
Both public stale-response APIs must reject the old answer. Any production-created
`wake_assignee` fallback is separately identified and remains unanswered; it is not
a restored native callback. The sealed observer proves no continuation marker was
created and all owned processes retired before public lease deletion. The company
must retain exactly the original run through cleanup.

Local provider-death remains excluded. The Python admission tests include a
real pidfd calibration against a synthetic title-changing child on native Linux;
the normal E2E unit wrapper invokes it with no provider credentials or network.
macOS runs metadata negatives and explicitly skips this Linux-only calibration.
That calibration and the earlier fake-Pi wrapper/bridge tests do not count as the
real paid Product lifecycle proof. This new candidate cell remains unqualified.

The pending-question controller-restart browser matcher accepts only the retained
issue's UUID or public identifier and the exact retained interaction ID. The UI
normally posts with the public identifier. Durable request, run, turn, session,
producer and single-delivery assertions remain required after submission.

## Pi active controls

The explicit-only `pi-controls` suite adds `pending-permission-stop` and
`same-turn-steering` on local and Daytona, each with one provider run, a
120-second active-turn timeout and a 300-second attempt budget. These four
control cases retain their behavior; the current matrix totals 26 Pi cells.
Pi 1/profile 13 and coverage revisions intentionally change the affected suite
fingerprints, so older qualification receipts cannot be reused. Catalog presence and
deterministic calibration do not constitute paid qualification.

Both cases create a task through the browser and select `approve-reads` and
`per_turn` through the public agent API before startup. They retain
`paperclip.e2e.pi-control-pending.v1` while an exact native Pi write and its
permission card are pending in one run/turn/session/source. The card's native
tool ID is joined to the canonical execution ID using the existing runnerd
identity mapping. Pi does not emit Cursor/Copilot diagnostic notices; those
notices are never synthesized. Earlier native reads can provide orientation;
other native operations cannot substitute for the observed write.

On Daytona, the operator first publishes the setup instruction file after the
owned observer is armed. If Pi delegates that native read, the fixture approves
only its exact request through the public API with `accept` (allow once). The
read must name the published random setup file, complete successfully in the
same native run/turn/session/source, and leave the file hash unchanged. The
fixture retains the request, resolution, completed read and both observer
snapshots. Only the two hash-bound setup permission records are excluded from
the write-permission count. All native read rows remain in the oracle. Another
permission, edit, shell command, foreign path or incomplete read cannot receive
this exemption. The tested write remains unanswered until Stop or browser Deny.
The production permission policy and all write/retirement assertions stay in
place. `pi-controls` version 7 and `pi-native` version 5 record this correction;
older attempt fingerprints and grades remain historical evidence.

Native tool arguments can arrive after the start event. An earlier null target
is allowed only until the same execution first supplies the exact expected
path. Missing targets, conflicting paths, another execution's path, or a later
loss of the proven path fail. The original start and permission rows remain
bound by retained hashes through control dispatch and settlement.

Stop awaits the pending evidence write and rereads that boundary before sending
one caller UUID to the public cancel API. It requires the original request's
normalized cancellation closure, a cancelled terminal, and the same-scope
caller-owned intent and acknowledgment audit IDs. Normal completion, a prior
permission decision, an expired request, and unacknowledged cancellation fail.
Only after cancellation does it attempt a stale **decline**, which must return
409. It never sends an allow decision. The task remains In Progress, with one
cancelled run and no automatic continuation.

Steering submits a random marker only in a browser comment after the permission
is pending, binds the queued comment to the exact body submitted by the
production Markdown editor, then clicks that comment's production Steer button. It records the
exact public POST's queue/revision/run binding. A rejected public POST ends the
journey before any denial. Success requires the saved run acknowledgment plus
the Product facade's same-turn acknowledgment item. The raw
Rust `acpx-control-*` transport echo is suppressed by the facade;
`CodexHarnessSession.steer` emits the durable correlated item after the command
acknowledges. A deterministic calibration invokes that actual producer. The
browser denies the original write only after acknowledgment while the request
still remains pending. Success requires correlated native denial, the random
marker as the persisted and visible final response, Done, and one succeeded
run. Merely echoing the comment in the transcript or scheduling another turn
cannot pass. Native `pi/follow_up` and durable native queue state are not tested.

Both cells require independent absent-target and zero-mutation evidence plus
owned process retirement. Local observation runs through cleanup. Daytona uses
the existing authenticated lease observer with exact image/executable pins,
fresh baseline/pending observations and its owned-process retirement seal;
retrieving that seal later does not claim later filesystem surveillance.
Missing cleanup fails the result. Provider-death recovery is outside these
cases. All screenshots and receipts use the existing evidence/redaction/result
pipeline; native USD may remain unknown and estimates remain distinct.

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
and `detach:false`, then asks the model to attempt immediate completion. Its marker
is a private diagnostic sentinel, not a requested user deliverable. The task keeps
empty completion evidence and forbids publication, extra commands, and waiting tools.
Suite definition v6 preserves this early-completion stress and every settlement
assertion. A retained v5 Daytona failure exposed a bootstrap wording conflict:
comma-separated prohibitions left “create or modify any file” as a positive clause
in the continuation objective's file-delivery classifier. Each bootstrap prohibition
now has its own explicit “Do not” sentence. The production delivery policy is unchanged;
actual requested file outputs still require accessible delivery evidence. That failed
attempt remains failed, and v6 requires fresh live qualification. A one-shot
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
`paperclip.e2e.native-active-stop-pending.v2` from the public API while exactly one
native permission remains pending, the exact controller run is running, and no
Stop or answer marker exists. The receipt independently binds native session,
normalized session, turn, source instance, request/tool IDs, source sequences and
canonical row hashes. An awaited artifact write and fresh pending reread precede
Stop dispatch; process-monotonic timestamps describe only these local observer
boundaries. Remote provider clocks and database transaction timestamps never
establish that ordering. The atomic caller UUID fence rejects an earlier racing
Stop instead of borrowing its acknowledgement.

Suite version 3 accepts either canonical card/tool-start arrival order. The
exact native origin, canonical tool start and unanswered permission must all
exist in both pre-Stop API observations. The v2 pending receipt adds the native
origin and tool-start row hashes and source sequences. The fresh reread and
settlement must preserve those exact rows; a later tool start cannot backfill
missing pre-Stop evidence. Command/path, request, tool, turn, session and source
checks remain strict. Cursor's native evidence projector still requires the
exact tool origin before it can emit correlated permission evidence. Copilot
emits permission evidence immediately, so its permission notice may also precede
the native tool notice. Calibration tests exercise both actual projectors in
both input orders. Neither policy claims the original ACP wire order of a live
attempt. Old v1 receipts are not valid inputs to the
new grader. Earlier paid failures retain their original definition and grade.

Suite version 4 and `paperclip.e2e.native-active-stop-settlement.v2` accept only
`pending_permission_cancelled`: the Product harness's exact
`runtime_request.cancelled` closure (`reason: turn_terminal`, matching request,
item and turn, no answer), then one exact `turn.cancelled` (`status: cancelled`,
`error: null`), plus the same scoped caller-owned native Stop acknowledgement.
Both events must belong to the retained source/session/turn and follow all four
pre-Stop evidence rows. The harness consumes raw backend request closures and
projects its own pending-request outcome before the terminal. Raw backend-only
`provider`, `requestType`, `replayAllowed` and `providerTurnId` fields are not
required from that Product projection. Replay refusal is independently checked
through the stale public answer below. A generic terminal without the retained
request and exact acknowledged caller UUID is insufficient. The v2 settlement
receipt records this changed oracle; historical v1 receipts and failed attempts
retain their original grades. Missing, duplicate, foreign, failed,
interrupted or normal terminal evidence fails. Only after this proof does the
fixture attempt a stale public answer, requiring HTTP409 and an unanswerable
browser card. It retains one cancelled run, issue `in_progress`, exact target
absence through continuous observation, and all observed owned descendants
retired. Local files require four fresh observations through cleanup. Daytona
instead retains two live snapshots (baseline and pending) plus one automatic
owned-process-retirement seal, with a continuous zero-mutation watcher and the
same complete root/descendant journal. Since suite version 2, this is retained as
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

### Copilot attached semantic completion evidence (suite 8)

Attached settlement now requires one native `paperclip_finish` lifecycle joined
to an invocation-captured, bounded Paperclip bridge receipt by exact call, input
and result digests in the same run/turn/native session and durable source stream.
A matching display title is not authority. The exact proposed completion input
must match a control-plane `run.result.accepted` body and the requested summary.
Transport `returned` alone, including a returned rejection, cannot pass. The
visible exact terminal comment remains an independent assertion. Both local and
Daytona cases reject extra native operations; existing attested bootstrap reads,
command settlement, process retirement and marker checks remain required.

The receipt reader fails closed when the production native receipt projection is
missing, partial, duplicated or outside its bounds (including 256 KiB for the
whole native rawOutput, which may repeat text). This oracle depends on the new
production semantic-receipt contract and does not regrade earlier failed runs.
The bridge call hash identifies the invocation and its native receipt. It is not
inferred from `run.result.proposed.itemId`, which can identify the run instead.
The v2 receipt keeps the raw invocation input digest separate from the normalized
input digest captured by that same authenticated invocation after production
validation. Raw arguments may omit schema, artifacts and attention requests;
the production validator supplies those defaults. The oracle never reconstructs
or normalizes a body to make it match. The raw call/input/result hashes still join
the native lifecycle; its normalized input hash must also match the authority.
Exactly one proposed body must hash to that normalized digest and equal exactly
one accepted body; identical duplicate proposals or receipts still fail.

Suite 8 writes `paperclip.e2e.copilot-semantic-completion.v2` and requires
`paperclip.semantic_tool_receipt.v2` under `paperclip_semantic_tool_receipt_v2`.
The authority has exactly eight bounded details. An explicit null normalized
digest is diagnostic only and cannot qualify a successful finish. Legacy v1
receipts do not qualify fresh runs. This fixture depends on the corresponding
production receipt and durable-redaction fixes; it does not supply them. The shell
result is one separate complete read lifecycle: pending and any progress name the
started shell, and its successful terminal also names the original command. A
completed-only read or a second shell read cannot inherit that exemption.

Denial case version 5 and denial settlement schema v3 are unchanged.

## Direct blocker fixtures

`blocker-cases.ts`, `blocker-fixtures.ts`, `blocker-flow.ts`, and
`blocker-scoring.ts` define the explicit local legacy `blocker-guidance` suite.
Its fixture registry creates a manager through the public API and assigns the
production operational skill to worker and manager. Company-wide evidence and
cleanup include unexpected manager runs. The grader checks saved human input,
requester identity for scope questions, ownership history, no additional work or
hires, and the browser-answer continuation. See [Direct blocker guidance](README.md#direct-blocker-guidance)
for coverage boundaries and run commands.


## Source-derived hiring template fixture

The explicit `hiring-templates` suite reuses the public company/agent, personal
managed account and browser chat fixtures. `hiringTemplateProfile` removes the
custom instruction bundle from the ordinary profile; the real agent creation
route selects the evaluated revision's CEO bundle. Keep its two local native
profiles, five expected runs and 15-minute deadline stable for paired runs.
`isManagedHiringCase` requests the account fixture and `chatNeedsApiTools`
enables only the existing API-tool path. It adds no private fixture endpoint,
provider fake or database write.

`hiring-template-flow.ts` reads the production instructions and company skill
files through public APIs before dispatch and verifies their hashes against the
checkout. The public run-events API supplies paginated read evidence after
execution. `hiring-template-scoring.ts` grades deterministic child documents,
actual worker identity/account, reuse and source coverage independently of the
agents' claims. `hiring-template.test.ts` calibrates production Codex/ACPX event
shapes, wrong/missing/late reads, incorrect/default bundles, source mismatch,
wrong hire/output, missing durable state, and an admissible historical four-file
CEO with a long coder role.

Preserve both dimensions in a comparison: `outcomePassed` describes the work;
`comparisonStatus` describes whether the expected sources and reads were proven.
Unprovable provider event shapes are coverage gaps. They must not become a
passing template comparison or a claimed behavior regression. The existing
report matcher paths carry the dimension and private final evidence carries the
explicit status. Provider runs are separately authorized; unit results establish
oracle calibration only. See the [suite contract](README.md#production-hiring-templates)
for evidence, budgets, cleanup and exact IDs.

Cursor native denial qualification requires one exact absolute-target command, a
correlated browser Reject once delivered after reconnect, six independent absence
samples, a complete continuous mutation watcher, and retirement of the actual
run-owned process tree. The pinned Cursor transport may report the rejected call
as completed and end the native turn; Paperclip must retain a failed run with
missing semantic finalization and an unfinished task. That is a denial outcome,
not task success or operator cancellation. Stop during an unresolved permission
remains a separate `native-active-stop/pending-permission-stop` gate.

Pi controls definition 9 and native definition 16 create an explicit title through the production search creation action and bind the task ID from the public creation response. The scoped task and assignee must match before any native control. Automatic naming is outside these strict native-operation fixtures; all existing permission, byte, process, run-count and cleanup assertions remain required. Preserve the failed title-lookup attempt as its original failure.
