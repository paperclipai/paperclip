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
