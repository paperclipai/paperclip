# Paid runner full-stack E2E

## Live provider connection journeys

See [PROVIDER-CONNECTIONS.md](PROVIDER-CONNECTIONS.md) for the explicit-only
`provider-connections` suite, local/staging target ownership, dedicated browser
profiles, credential handoffs, private evidence, and cleanup contract.

The [public MCP suite](PUBLIC-MCP.md) adds explicit paid assistant/plugin journeys
with authenticated browser consent, real MCP tool use and independently graded
team execution. Select `--suite public-mcp`; it is excluded from `--all`.

For family selection, ownership, provenance, history, and failure taxonomy,
see the [Paperclip evaluation guide](../../doc/evals.md). This README is the
authoritative runbook for Product E2E runner cells; the separate Runner Evals
protocol guide lives at
`packages/paperclip-runner/docs/runner-protocol-live-evals.md`.

This is the billable browser acceptance campaign system for Paperclip runner
profiles. It is deliberately separate from `tests/e2e`: every independently
scheduled execution gets
a fresh Paperclip home, embedded Postgres database, instance configuration,
port, workspace, company, encrypted secrets, environment, and agent.

`pnpm test:e2e:runner:unit` runs the native-completion source gates with
Node's test runner, then the Product support tests with Vitest. A Node test
file must not be collected as an empty Vitest suite.

## Native connection guidance (explicit only)

The manual-only native-connection-guidance suite separates connection-policy
discovery from fixture instructions. It reuses five Everyday journeys on local
native Codex, ACPX Claude and OpenCode: service approval/decline, new Notion
setup decline, external-provider decline and choosing the second provider.
Fifteen cells are configured, not live-qualified by their existence. Select an
exact execution ID or this suite; --all and generic profile selectors exclude it.

The three decline prompts define a brief explanation as the permitted fallback.
They do not mention the future decline, name connection tools, prescribe a
provider, or tell the model not to retry. The approval and second-provider
prompts remain identical to the original stories. The historical
everyday-workflows cases and their original grades remain unchanged.

Each cell allows one attempt and expects two provider turns (three for choosing
Arcade and then granting tool access). Each retains a twelve-run
maximum and twelve-minute deadline, and verifies 1,000-cent company and agent
hard stops through public records before task creation. All actual runs,
usage/cost gaps, controller retries and cleanup must remain in the report.
No real third-party mutation occurs. The external-provider decline includes
the same deterministic company Arcade gateway as the positive control, with
no agent install or allowed tool at task creation. Public effective-access
readback verifies that precondition. The positive case selects Arcade, then
approves its separate scoped access card through the browser. Only that grant
permits the single HubSpot call. Decline has a real zero-call counter.
The browser matches the task route and visible identifier, so agent title
changes cannot invalidate the checkpoint.

The new decline oracle requires the saved decision, exactly one interaction,
unchanged connection identities, and an explanation after the decision from a
successful run of the same agent on the same native task. The public comment createdByRunId field
owns attribution; names, ordering or counts cannot substitute. Service/provider
declines require observed zero fixture calls. Notion setup ends before
credentials or a service invocation; it does not qualify real Notion access.
The original lifecycle, native identity, approval and document checks still run.
These fallback tasks expect Done; they do not qualify blocking when essential
work remains, arbitrary setup success, independent work while waiting,
explicit retry after decline, or general integration quality.

Use the existing report publisher and retained artifact boundary. The suite
definition digest includes its prompts, flow, graders, fixture setup and browser
submission code. Compare frozen sources under identical fixture/model/budget
controls before using it to qualify a production instruction change. See
[the connection audit](../../doc/plans/2026-10-06-native-connection-guidance.md) and
[the preserved baseline failures and repair](../../doc/plans/2026-10-07-native-connection-baseline-repair.md).

## Native procedure guidance comparison (explicit only)

Select `--suite everyday-workflows --environment local --case hire-reuse --case delegate-feedback
--profile runner-codex --profile runner-acpx-claude --profile runner-opencode` for the six comparison
cells on native Codex, ACPX Claude, and OpenCode.
Both variants use the same Studio Lead persona, original user requests,
artifact oracle, lifecycle checks, models and permissions. Each cell permits
one attempt, a 12-minute deadline, at most 12 story run records, and a
1,000-cent company hard stop; the lead also has a 1,000-cent hard stop. Worker
runs count toward the company budget. The suite is excluded from `--all`.

Compare frozen branches on the same master with identical fixture sources.
Retain each original grade, source SHA, harness digest, actual run inventory,
downloaded artifacts and partial cost evidence. Check hiring identity/reuse,
worker ownership, delivered revisions, dependency release and parent completion
ordering independently of aggregate grades. These bounded stories do not
qualify every existing-blocker combination or arbitrary provider resume.

The provider-free `native-procedure-measurement.test.ts` uses the server's real
tool authority and captures scripted start/resume/continuation delivery plus
the OpenCode MCP catalog. It includes descriptions and argument schemas. Its
byte counts are not model token counts or proof of an upstream harness's lazy
loading/truncation. The older completion measurement used a partial catalog;
do not use it as a full production tool-payload baseline.

The vocabulary is: a **campaign** is one workflow invocation against one SHA; a
**suite** is a durable testing purpose; a **matrix** is that suite's profiles ×
environments × cases; an **execution/cell** is one parallel job; and an
**attempt** is one isolated harness run, including an infrastructure retry.

The browser creates and assigns the task; fixtures use public APIs. The
`accept-while-running` case additionally holds the committed card’s creation
response in the test server until browser acceptance, to exercise real overlap.

The launcher always sets `PAPERCLIP_ANNOUNCEMENTS_ENABLED=false` for its isolated
instances so announcement panels do not obscure screenshot evidence. No shell
or workflow configuration is needed, including for Daytona cells.

## Pi controls (explicit only)

`--suite pi-controls` selects four candidate Pi cells: pending-permission Stop
and browser same-turn steering, each local and Daytona. Discover without
credentials using `pnpm test:e2e:runner -- --list --suite pi-controls`. For an
authorized bounded attempt select, for example,
`--id pi-controls.runner-acpx-pi.local.pending-permission-stop
--max-automatic-retries 0 --max-parallel 1`.

The [fixture contract](FIXTURES.md#pi-active-controls) requires exact pending
native-write evidence, caller-owned control acknowledgments, independent
no-effect/retirement proof and the actual production task UI. Daytona also
requires the existing immutable image and executable digests. These cells do
not establish native follow-up queue persistence or provider-death recovery.
The current Pi matrix has 26 explicit cells (13 local and 13 Daytona), including
these four controls, the pending-native-question restart cases, and one Daytona
provider-death case. Pi's profile
remains pending; catalog presence is not live qualification.

## Provider-free browser bootstrap regression

`pnpm test:e2e:runner:browser-support` includes a wide development-module graph
loaded before and after the production service worker takes control. It keeps
full traces and checks that Vite module loads do not create worker fetches or
leave the page empty. This isolates browser loading; it does not create a
Paperclip task, run an agent, or replace a Product E2E result.

## Conversational confirmation replies (explicit only)

`--suite confirmation-replies` selects ten local native Claude/Codex cells:
conversational single-task approval, saved-plan approval, rejection, card-click
acceptance as a control, and ambiguous approval with two independent pending
proposals. The onboarding cells use the production wizard, runtime switch and
persona. The ambiguity fixture creates ordinary board cards through the public
API, sends "Yes, go ahead" through the browser, requires both to stay pending
with a clarification reply and no execution, then approves only one and rejects
the other through separate browser messages.
The board-created cards also check that fresh and resumed chat turns receive
the current confirmation identities, including cards outside provider memory.
Only ordinary, current-session pending confirmations enter this bounded context;
the resolution endpoint still rechecks live state and permissions.
Clarification may be a fresh chat reply or a source-bound question card, including
a native question-set description and its proposal choices. A generic question
about tone or deadlines is not evidence that the ambiguous approval was clarified.
Unauthorized state changes fail immediately. Clarification wording is graded
after capturing later decisions and reload receipts, so a new wording variant
does not discard the rest of the paid journey's evidence. A wording failure
still fails the case; any later offline regrade must be reported separately.

The independent oracle requires the exact original card to hold the decision,
source user-comment ID and resolving agent/run. Acceptance must precede child
creation. Expiring/hiding the card, reporting acceptance only in prose, or
finishing work with a pending card fails. Browser reload verifies the displayed
accepted/rejected receipt. Existing card-click behavior remains unchanged.
Accepted onboarding cases also use the 120-second completion/result-access
probe and retain its semantic evidence. Inspect final prose for obsolete
requests to clear the approval card; mechanical success alone does not establish
prose quality. Provider-scoped Claude jobs require separate retained-probe
judging, as described below.

No model-generated outcome or direct database mutation supplies a pass. Source
SHA, definition hash, model, run evidence, screenshots, failures, cleanup and
billing use the existing report pipeline. This suite is opt-in and excluded
from `--all`; it does not qualify governed tool approvals, human-only policies,
question-form extraction, or remote execution.

```sh
pnpm test:e2e:runner -- --list --suite confirmation-replies
pnpm test:e2e:runner -- --suite confirmation-replies
```

## Completion-update probes (explicit only)

`--suite completion-updates` selects ten local Product E2E cells: native Codex
and native Claude, each with onboarding, idle handoff, busy handoff, two-task
handoff, and restart recovery. These exercise the production completion-delivery
path and agent-authored responses. There is no separate completion feature flag.
The onboarding cell reuses the real wizard and its existing pre-execution native
runtime switch, retaining the production persona.

The idle chat cell asks the agent to delegate one welcome note to a named worker and
report its result without another user message. A bounded local file read in
the managed project workspace delays completion until the source chat is positively
observed idle, with a three-minute handoff setup budget and a four-minute worker
wait limit. The brief is then released, the worker must save the output and
reach Done. Its output must include the start time supplied only in that brief, allowing
ordinary numeric and written forms. That check runs after completion observation
so a content mismatch cannot suppress the communication evidence.
The source thread is observed for 120 seconds. The probe retains a later
correction even if an earlier reply already passes delivery and access. A later
clarification does not erase an earlier accessible delivery.
The busy cell holds a separate source reply open until the worker finishes; the multiple cell delegates two notes and requires one completion per task. The restart cell holds the source provider at a fixture reference gate, then restarts the server after durable Done but before publication and releases the gate. The gate makes the interruption boundary observable and prevents a fast successful reply from racing the restart assertion. The onboarding cell records its naturally occurring timing.

The mechanical oracle requires a run-attributed source reply after durable
completion, plus the actual saved output or a navigable task/output link.
Browser verification checks that reply after reload, including the UI's automatic
task-reference links. It opens the rendered result target, checks the task heading,
and reads its saved output through the public API. Known request markers, identifiers without a rendered link,
successful runs without Done, user-authored replies,
and replies on the worker task do not satisfy it. Extra tasks and modified
worker output are rejected by the chat story. Provider turns are bounded by
the existing first-task limit (12) and case-specific chat limits (2–7).

A source reply counts as completion delivery only when its run received server-recorded Done facts for that specific task. A late initial handoff reply with a valid task link cannot substitute for the missing callback.

**Mechanical passage is not answer-quality qualification.** Inspect
`completion-update.json`, its `latestResponse`, and all retained replies against the included semantic
rubric: correct completion claim, useful result explanation, accessible output,
and no invented verification or follow-up work. A stale promise with a valid
link can pass delivery/access while failing this separate review. Do not
replace this distinction with keyword matching for “done.”

When `OPENAI_API_KEY` is configured, the suite automatically uses the pinned semantic judge, reserves at most $0.50 per request, and includes its measured usage and any unknown spend in campaign billing. The Codex idle case also checks accurate, stale, unsupported, corrected, duplicate, redundant-acknowledgement, distinct-task, pending-then-joint, joint-then-repeated, supported-content-check, unsupported-content-check, rendered-task-link, unlinked-status-only, completion-then-result, completion-then-result-then-repeat, and recap-with-new-result control replies (up to seventeen requests); other cases judge only their recorded task results. The trusted workflow currently supplies only each cell’s provider key, so Claude cells retain their probe for separate grading and explicitly mark accuracy unqualified. Do not interpret a green mechanical campaign as semantic qualification until those retained probes are judged. Mechanical evidence remains separate from the accuracy verdict.

To judge an older retained probe separately:

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/runner-e2e/completion-judge.ts --evidence /path/to/completion-update.json --max-dollars 0.50 --approve-external-judge yes
```

The multi-task fixture records the other explicitly delegated task and its saved output as related ground truth, so a joint reply is checked against both real results. Company boundaries and document ownership are validated; unrelated tasks are never added to the judge input.

The busy-chat case holds the real source conversation's document-save response after commit, using the existing isolated-server transport gate. It arms only that conversation, verifies the committed document and active source run, waits for the worker's real Done transition and public deferred-wake receipt, then releases the tool response. This avoids depending on a provider keeping a shell job in the foreground. The production server and task outcomes are unchanged by the fixture.

Grader v14 inventories the completed tasks referenced by each reply, including implicit acknowledgements, plus the tasks whose results each reply links to or substantively presents, with a rationale and any earlier reply it genuinely corrects. Code checks that complete, chronological inventory for repeats: a later reply may recap a task if it adds another newly reported task, supplies the first access to an already announced result, or corrects an earlier claim. Browser-observed links are included in the evidence, so an automatically linked task identifier counts as result access. Foreign-task links and links from another reply do not. A status-only announcement followed by its result link is useful; repeating that link afterward is redundant. Paraphrased repeats and extra acknowledgements without new results fail. The retained inventory makes each duplicate finding inspectable; controls cover pending-then-joint updates, joint-then-repeated updates, and explicit corrections. Corrected statements replace the earlier statements when grading accuracy and access. It receives the synthetic user request and released brief (onboarding requirements come from the actual submitted user comments and resolved form answers, with their evidence IDs), so claims of checking visible content can be compared with the actual requirements; external-action claims still require evidence. This semantic check supplements the mechanical check for duplicate persisted replies from the same delivery.

The standalone command requires explicit approval to send sanitized fixture evidence to OpenAI. The request omits task titles, planning documents, unrelated comments/documents, and run metadata; it redacts loaded credentials, credential-shaped text, email addresses, and phone numbers before hashing and transmission. It requires `OPENAI_API_KEY`, reserves the bounded cost before a single request, and writes an exclusive `.quality.json` sidecar containing rubric/evidence hashes and usage. The judge gives its reasoning and citations before the verdict; the response schema restricts references to the provided evidence IDs; invalid verdicts remain failures and retain a redacted `rejectedVerdict` for diagnosis. It never changes the original mechanical result. An unavailable or miscalibrated judge leaves semantic qualification incomplete and is classified as evaluation infrastructure failure rather than product failure.

`completion-update-boundary.json`, worker output, source comments, per-run
event evidence, and marked screenshots retain the chronology for diagnosis.
Source SHA, suite digest, models, attempts, cleanup and partial billing remain
in the normal result/report pipeline. A missing follow-up after a completed
worker is a behavior failure; a failure before that boundary is not proof of
the communication defect. Use the standard dashboard to compare the ten cells.

```sh
pnpm test:e2e:runner -- --list --suite completion-updates
pnpm test:e2e:runner -- --suite completion-updates
```

## Credentials

Copy `.env.runner-e2e.example` to `.env.runner-e2e.local` and fill only the
credentials needed by the selected cells:

```bash
cp .env.runner-e2e.example .env.runner-e2e.local
chmod 600 .env.runner-e2e.local
```

Shell variables take precedence over the local file. The recognized names are:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `OPENROUTER_API_KEY`
- `KIMI_MODEL_API_KEY` (local-only pending Kimi CLI/ACP profiles)
- `XAI_API_KEY` (local Grok API-key profile)
- `GROK_AUTH_JSON` (local native Grok subscription profile)
- `DAYTONA_API_KEY`
- `CURSOR_AUTH_TOKEN` (extended Cursor candidate)
- `COPILOT_GITHUB_TOKEN` (extended Copilot candidate)
- `PAPERCLIP_E2E_DAYTONA_IMAGE` (Daytona only)
- `PAPERCLIP_E2E_DAYTONA_NODE_SHA256` and `PAPERCLIP_E2E_DAYTONA_RUNNERD_SHA256` (native Cursor/Pi/Copilot Daytona fixtures; exact `sha256:...` executable digests from that image)

The image must be an immutable `image@sha256:...` reference. The launcher
reports missing variable names but never prints values. It passes raw provider
keys only to Playwright, which posts each value once to the company-secrets API.
Paperclip receives secret references in agent/environment payloads. Provider
keys, Daytona keys, `DATABASE_URL`, and `DATABASE_MIGRATION_URL` are removed
from the Paperclip child process.

Kimi keys are recognized for local catalog, schema, and isolation tests only.
Its explicit context-integrity profiles are blocked before credential loading
until runtime identity, authentication, skills, session, and billing
qualification is complete. Grok profiles are explicit-only and require their
matching API-key or subscription credential.

Never put credentials in `catalog.ts`, screenshots, fixture metadata, workflow
inputs, or a tracked env file.

## Local commands

Install dependencies and Chromium once. Native local cells also need the local
runner binaries:

```bash
pnpm install
pnpm exec playwright install chromium
pnpm --filter @paperclipai/paperclip-runner build:runner-binaries
```

List cells without loading credentials or starting Paperclip:

```bash
pnpm test:e2e:runner -- --list
```

Examples of explicit billable runs:

```bash
pnpm test:e2e:runner -- --id core-compatibility.legacy-codex.local.message-marker --headed
pnpm test:e2e:runner -- --suite openrouter-model-breadth --case hello-complete
pnpm test:e2e:runner -- --group native --environment local
pnpm test:e2e:runner -- --profile runner-codex --case message-marker
pnpm test:e2e:runner -- --case plan-revise-accept --group local
pnpm test:e2e:runner -- --case ask-question --group native
pnpm test:e2e:runner -- --suite daytona-warm-continuity
pnpm test:e2e:runner -- --all
```

The catalog contains the explicit-only suites alongside the standard suites. It also includes the explicit-only everyday and
[lifecycle baseline](LIFECYCLE-BASELINE.md) suites. The latter adds 46 real-provider
cells pairing narrative variants and exercising durable lifecycle boundaries;
it is excluded from `--all`. `core-compatibility` (**Core Runner Compatibility**)
is seven major runner profiles × local/Daytona × three
workflows: 42 cells. Its cases are:

- `message-marker`: one basic visible response and Done transition;
- `plan-revise-accept`: an initial Plan, a browser-requested revision on the
  same Plan, browser acceptance of the new revision, and verified execution;
- `ask-question`: a direct answer from a task created in Ask mode.

`openrouter-model-breadth` (**OpenRouter Model Breadth**) is four qualified
models from the tracked weekly tool-capable ranking snapshot × native OpenCode
× local, with 10 supported model/workflow cells. Xiaomi MiMo V2.5 remains
recorded in the immutable ranking snapshot but is excluded from paid
qualification because its latency repeatedly exhausts the cell deadline.
DeepSeek V4 Flash remains qualified for hello and question/resume, but its Plan
cell is excluded after three successful semantic completions consistently
ignored the required exact final response. Tencent HY3 likewise remains
qualified for hello and question/resume, but its Plan cell is excluded after
two fresh attempts completed every durable Plan and finalization operation yet
consistently replaced the required exact visible terminal marker with prose.
Its cases are:

- `hello-complete`: a basic nonce response and explicit Done transition;
- `question-resume-complete`: one structured question, browser selection of
  “Cobalt,” then a resumed completion on the same task; and
- `plan-approve-complete`: one exact two-step Plan, browser approval of that
  revision, then a resumed completion on the same task.

`local-session-integrity` (**Local Session Integrity**) is the seven supported
local native and direct-adapter profiles × two two-run structured-question
workflows: 14 cells. Both prove that a required structured interaction is
rendered, answered in the browser, and resumed once on the same task without
duplicating the final response. The second workflow restarts the isolated
Paperclip server while the interaction is waiting, reloads that state, and
then resumes it. The suite has no Daytona cells.

`instruction-persistence` is an explicit-only three-cell workflow: legacy and
native Codex locally, plus native Codex on Daytona. Each creates six browser tasks
for the same agent. The editor first creates a nested supporting file. The first
run edits its registered AGENT_HOME using ordinary filesystem tools: instructions,
nested text, editor-created content, and exact binary bytes. The oracle checks the
current files, a stopped-run save receipt, and absence of newly appended history.
The first task also publishes a small verification receipt for the normal
completion contract; the personal files stay in the agent directory.
After a Paperclip restart, a fresh task must upload a downloaded proof attachment
containing independent saved nonces absent from its prompt. A third task edits its
private copy while the browser edits the same current file. The later run sync
must win for that changed file, preserve an unrelated board-created file, and
produce no conflict candidate or manual review step. Exact bytes, downloads,
and receipts are independently checked; model claims alone cannot pass.
Three further tasks fill a sparse personal file to its 256 MiB limit, exceed
that limit, and clean it up. Every run must still succeed; the run UI must show
a warning while full and clear it after cleanup. Rejected bytes must not replace
the saved file. This adds at most one 256 MiB saved fixture per isolated agent.
The deadline is twenty minutes per cell, with six expected provider runs;
normal instance/Daytona cleanup, screenshots, evidence, and billing apply. Run with
`pnpm test:e2e:runner -- --suite instruction-persistence`. Managed directories in per-turn sessions collect after provider stop. The separate
`daytona-warm-continuity` suite covers incremental saves while retaining a live native process.

`daytona-warm-continuity` (**Daytona Warm Continuity**) is exactly two paid
cells: legacy Codex and Runner Codex against one reusable warm Daytona
configuration. Each cell creates a real project with a primary local-path
workspace through the API, selects it in the browser task dialog, and performs
three browser-driven turns on one issue. Every turn reads and extends the same
nonce file, verifies host copy-back, records scheduler/run/end-to-end timing,
and asserts `created`, `resumed`, `resumed` lease acquisition on one sandbox.
Runner Codex additionally proves stable native session, provider session,
runner instance, PID, and process-start identity. The ordinary warm cell uses
managed instructions and edits AGENT_HOME on every turn: a growing memory file,
an unchanged 8 MiB binary, and a deletion. Public API reads independently verify
the canonical bytes after every turn. Native checkpoint receipts must show only
the changed memory file transferred on turns 2 and 3; the PID oracle remains strict.
The journal stress cell retains fixed external instructions as a control. Each warm turn is bounded to ten
minutes, the cell to thirty minutes, and cleanup explicitly deletes the
sandbox rather than waiting for Daytona's idle timeout.

`daytona-journal-continuity` is one explicit-only native Codex cell. Select
`daytona-journal-continuity.runner-codex.daytona.large-journal-three-turn`.
It reuses the three-turn warm workflow with 240 separate ordinary execution-tool calls, each printing a bounded 65 KB
synthetic sample through the real provider. Before the first browser follow-up,
a read-only controller journal oracle requires the exact completed run's journal
to exceed two MiB. Only byte and call counts enter evidence. No runner state or database
is injected or modified. The usual workspace, sandbox, provider, process,
three-run, screenshot, timeout, billing, and cleanup assertions remain required;
`--all` excludes this stress case.

`daytona-git-streaming` is an explicit-only native Codex Daytona cell for
large Git filename snapshots. Run
`pnpm test:e2e:runner -- --id daytona-git-streaming.runner-codex.daytona.large-path-three-turn`.
This heavy-file cell explicitly configures the environment's 20-minute native
idle timeout and a 25-minute Daytona auto-stop interval. It checks the admitted
runtime policy before each continuation; the environment policy takes precedence
over the agent setting. Large copyback plus the next preparation
can exceed the normal five-minute idle window; the PID and process-fingerprint
continuity checks remain strict. The ordinary warm-continuity cell keeps its
existing five-minute policy.
This Git stress cell uses a fixed external instruction bundle to isolate workspace
transfer from managed agent-file persistence. The ordinary warm cell separately
requires incremental managed-file checkpoints and the same strict process continuity.
It seeds an empty local Git project, creates 60,000 small untracked files through
the real provider, then performs the same three browser-driven review turns.
Each later turn updates all 60,000 generated files to distinct turn-specific
contents. Before each follow-up and after the last turn an independent host oracle reads every copied-back file
and proves the generated NUL-delimited filename list exceeds 32 MiB
(39,828,890 bytes). It also checks whitespace, newline, option-like, Unicode,
and glob-like filenames. Each turn is bounded to fifteen minutes and the cell
to fifty minutes, including five minutes for setup, host verification, and cleanup
outside the turns. Preparing and copying back this many files exceeded the
ordinary warm fixture's ten-minute turn limit on CI. It keeps the warm suite's
billing scope, screenshots, and explicit sandbox cleanup; `--all` excludes it.
Before each follow-up and after the last turn, public durable run records must
show committed native finalization, successful workspace receipts, no active
workspace operation (including cleanup without a run ID), and no scheduled native recovery. A succeeded run or
correct host bytes alone cannot hide an overlapping finalizer retry.

`agent-chat` (**Persistent Agent Chat**) has eight workflows on `legacy-codex`,
`legacy-claude`, `runner-codex`, and `runner-acpx-claude`: **28 local cells**.
They cover continuity across server restart, fresh context after `/new`,
Stop/reset/resume, draft/revise/approve/plan handoff, clarification with existing
project reuse, and a new project with two repository URLs. Each cell opens the
production chat surface and resolves the backing issue through the chat API.
The source conversation must settle to `in_review` / `waiting`; handed-off
execution tasks must finish with their initial Plan and output documents.
Reset runs are retained separately from the 76 expected run attempts in this
suite. Cancelled turns and execution-task runs remain included in billing and
cleanup. The production chat directive is injected normally; fixtures do not
replace it with completion instructions. Daytona is excluded.

The native chat profiles use production provider permission defaults, rather than
full-auto overrides, for plan handoff, task creation, and reassignment.
The native Codex and Claude profiles also cover reassignment of existing ready
and backlog tasks. The oracle verifies stable task IDs, preserved descriptions,
assignment audit evidence, exactly one successful successor run and its output
document, no backlog execution, and a usable source conversation after reload.

`agent-chat-hardening` is an explicit-only native Codex/Claude suite with
**18 cells: 12 local and six warm Daytona**. It adds startup Stop/reset,
hire/delegate/reuse, grounded blocker reporting with source-document review,
and committed-send retry. It also runs active Stop/reset and restart continuity.
Daytona selects active Stop/reset, restart continuity, and committed-send retry.
The 56 expected run attempts include cancelled attempts; synthetic resets are
recorded separately. The suite uses production permission defaults and prompts.
Only hiring and cross-task status/review enable the opt-in native API tools.
Hiring uses a personal managed AI connection and verifies the hired worker's
actual execution account. This is not an onboarding-default qualification.
The hiring checklist and review request a `Reference: ...` line. This gives the
fixture marker a neutral label instead of leaving the agent to choose credential
syntax such as `Tracking token: ...`. Exact marker, authorship, worker reuse,
and saved-output checks remain required. This case tests coordination, not
credential-redaction policy.

Stop during startup and Stop during an active response are separate boundaries.
The native active-response case requires a recorded provider turn start; generic
lifecycle/performance events are insufficient. The startup case must stop after
a process launch request but before a provider turn starts. Missing the boundary
fails the case instead of silently testing another phase.

Restart continuity requires the agent to recall a phrase after the server
restarts. The final prompt does not reveal that phrase. A generic successful
reply after restart cannot pass this check.
The browser leaves the old development client before the server stops, then
opens the canonical chat route and waits for the composer. This avoids racing
Vite's automatic reconnect navigation against the test's explicit navigation.

The blocker query requests a JSON status snapshot. It must name the current
recorded blocker and report zero active runs independently of the task's blocked
status. Mentioning the right blocker only as resolved history cannot pass.

The committed-send case drops the browser's acknowledgement after the server
saves its comment. It waits for the agent to save one backlog task, restarts
Paperclip, and replays the exact public request with the original client request ID. It
requires the original comment, task, plan, and single consuming run. This proves
HTTP request idempotency across restart, not replay safety for an ambiguous
provider tool response. Existing native tool-receipt tests cover that boundary.

`agent-chat-stories` adds six explicit-only local cells across native Codex and
Claude. `enable-disable-resume` uses the Experimental settings UI to enable
Agent Chat, starts a conversation, disables new messages, verifies the public
write endpoint rejects a send without creating work, and re-enables the same
conversation with its remembered context. The company, credential, and native
agent are fixture-provisioned. This qualifies the experimental-settings path,
not native first-run onboarding: the current production wizard offers legacy
adapters. Native API tools are enabled by default, subject to the
[operator controls](../../doc/runner-api-tools.md#default-availability-and-operator-controls).

`followup-while-running` and `revise-while-running` send a second browser message
while the provider runs a bounded command waiting for a fixture brief file.
The command publishes its own readiness file; the harness verifies the original
run is still active after the follow-up is saved, then supplies the brief.
The final reply must contain the previously undisclosed brief reference and the
new request's marker. The revision case also checks the saved plan uses Friday
instead of the original Monday. The oracle permits either steering the active
run or one queued successor, but rejects missing/duplicate comments, failed or
unfinished runs, stale plan contents, and unintended tasks/projects. This does
not qualify active-task reassignment or worker-crash recovery.
The maximum run count remains the cost estimate; the shared harness honors the
one-run minimum only for these two interruption cases. Exactly one reply may
consume the follow-up marker, and it must be attributed to the final provider run.

```sh
pnpm test:e2e:runner -- --list --suite agent-chat-hardening
pnpm test:e2e:runner -- --id agent-chat-hardening.runner-codex.local.stop-startup-new-resume
```

The independent, explicit-only `native-completion` suite qualifies native finish/block descriptions on unchanged master defaults. It preserves the original assigned-skill document journey and pairs it with whole-task blocking across three native profiles, with enforced single attempts. See [NATIVE-COMPLETION.md](NATIVE-COMPLETION.md) for admission, provenance and limits.

The separate, explicit-only `native-instruction-consolidation` suite reuses those original tasks and strict graders to compare completion constraints on the production defaults at `2a8a99e4a5f69aa803b3f10b982f583e75a87042`. It declares six local cells: document completion and whole-task blocking on native Codex, ACPX Claude, and OpenCode. Each cell allows one attempt and applies a 1,000-cent company and agent budget hard stop. Its source gate rejects dirty, mixed, unknown, or unrelated source changes before credentials load. A provider-free fixture captures the complete Paperclip instruction/tool/message projection at the scripted runnerd RPC boundary on start, full-task resume and compact user-follow-up continuation for native input v4 and v5. That capture measures bytes; it does not measure vendor-owned prompts, tokens, billing, or model behavior. See the [comparison plan](../../doc/plans/2026-10-03-native-completion-consolidation.md) for exact scope and live qualification limits. Existing `native-completion` results do not qualify this new reduction.

The corrected source variants add explicit blocker explanations and canonical document citations. Accepted feedback repeats links only for this run's current saved revisions, and Markdown navigation preserves document anchors after issue details load. Observation v3 independently requires the persisted provider final to explain missing release/deployment access and, for completion, link this task's one revisioned document on the same origin. A correct structured blocker, an unblock action alone, or an unbound/foreign document URL cannot pass. These stricter checks and browser navigation apply only to the manual instruction comparison; the existing `native-completion` suite keeps v2 checks. Task prompts and the durable-output oracle remain unchanged. Admission now requires eighteen shared runnerd RPC captures and six direct OpenCode HTTP captures using a local fake server, all provider-free. Replay of retained v2 evidence is a separate diagnostic, never a replacement for its original verdict. See the [answer correction](../../doc/plans/2026-10-04-native-completion-answer-fix.md).

`context-integrity` is an explicit-only local suite with two bounded cases across
ten listed legacy/native profiles (20 cells). Six cells are pending-prerequisite
profiles and are listed for discovery but rejected before provider credentials are
loaded: `legacy-kimi-cli`, `legacy-kimi-acp`, and `legacy-grok`, each with both
cases. The seven previously qualified profiles remain unchanged. Pi is not listed
because no qualified model source exists. `ordered-comment-continuation`
sends three separate user comments through the public comments API, retaining an
intentional repeated comment before a changed scope. `assigned-skill-explicit-invocation`
creates and pins a task skill through public skill APIs, requires an explicit
provider skill invocation, and keeps the output requirement in the skill body.
The suite is excluded from `--all` and has no Daytona cells.
Each cell applies a public API 1,000-cent company and agent budget hard stop
before task creation and records both limits in its evidence. Unknown provider
billing or a budget incident is not admitted as a pass.

```sh
pnpm test:e2e:runner -- --list --suite context-integrity
pnpm test:e2e:runner -- --id context-integrity.runner-codex.local.ordered-comment-continuation
```

`stock-harness` reuses ordered continuation, assigned-skill invocation, and chat
restart journeys with production-default hires instead of the custom QA manual.
Its 24 explicit local cells cover eight legacy/native profiles and are excluded
from `--all`. Run `pnpm test:e2e:runner:stock-harness` for the credential-free
instruction-layering, hire, and shared-prompt prerequisites. The
[suite contract](STOCK-HARNESS.md) maps each change to its graders, budgets,
evidence, and remaining qualification limits.

Each hardening oracle has positive and plausible-negative calibration tests.
The review grader parses the worker's saved JSON and compares both source values
and the consistency verdict. Hiring requires one identity, correct reporting
line, managed credentials, and real task execution; chat claims cannot pass it.

```bash
# Run these after deterministic checks, with the required provider keys set.
pnpm test:e2e:runner -- --id agent-chat.legacy-codex.local.continuity-restart
pnpm test:e2e:runner -- --id agent-chat.legacy-claude.local.continuity-restart
pnpm test:e2e:runner -- --suite agent-chat
```

The regular browser suite has deterministic process providers in
`tests/e2e/fixtures/agent-chat.mjs`. It exercises the real queue, APIs, database,
MCP project tools, and shared task UI without provider billing. Only upstream
GitHub discovery is simulated, scoped to a fixture-only credential; repository
permissions and mutations remain real. Run it with:

```bash
pnpm --filter @paperclipai/ui build
pnpm test:e2e tests/e2e/agent-chat.spec.ts
# Against a dedicated authenticated test instance configured per that suite:
pnpm test:e2e:multiuser-authenticated --grep 'agent chats'
```

Both suites save and restore experimental settings. Browser E2E always starts a
throwaway instance; never point the authenticated suite at the running demo.
Missing provider credentials fail paid preflight and are not passing coverage.

The default `--all` selection is 171 cells (148 local and 23 Daytona) and 371
expected paid agent turns. The explicit-only everyday suite adds 38 catalog cells
and chat hardening adds 18; chat stories adds six. All three are excluded from
`--all`. The full catalog has 239 cells.
Follow-up steps remain ordered within their cell; all other
cells are independent. Narrow selectors are strongly recommended while
developing fixtures.

`--suite`, `--group`, `--profile`, `--environment`, and `--case` are repeatable. Repeated
values in one dimension use OR semantics; dimensions and repeated groups use
AND semantics. `--id` is exclusive with dimension selectors and `--all`.
`--headed`, `--ui`, and `--debug` are forwarded to Playwright. An unknown
selector, an empty selection, or a run with no explicit selector exits before
Paperclip starts. `--max-parallel <n>` controls the number of isolated
profile/environment/case harnesses that can overlap (default 1, also configurable
with `PAPERCLIP_E2E_MAX_PARALLEL`). `--max-automatic-retries <0|1>` controls the
launcher retry budget (default 1). Set it to 0 for a single-attempt comparison;
it suppresses both transient-infrastructure and provider-variance retries while
preserving the original failure classification. Headed/UI/debug runs are forced
to one worker.
The Plan case is still sequential internally because its turns share one task;
it runs in parallel with unrelated scenarios.

Use a single `--id` smoke test for routine local verification. Full-matrix
parallelism is intended for GitHub Actions; raising local parallelism starts
multiple Paperclip/Postgres/Chromium stacks and can consume substantial CPU and
memory.

Credential-free checks are:

```bash
pnpm test:e2e:runner:unit
pnpm test:e2e:runner:typecheck
```

The OpenRouter ranking snapshot is tracked in `openrouter-models.json`; nightly
runs never mutate it. Refresh it deliberately, review the source/capture/hash
diff, and rerun credential-free checks:

```bash
pnpm test:e2e:runner:models:update
```

## Daytona image

Use the immutable digest printed by the `Publish verified Daytona image` job,
or publish the current source locally:

```bash
content_id="$(pnpm --silent test:e2e:runner:image-id)"
source_revision="$(git rev-parse HEAD)"
image="ghcr.io/paperclipai/paperclip-daytona-runner:e2e-content-${content_id}"
if ! docker buildx imagetools inspect "$image" >/dev/null 2>&1; then
  docker buildx build \
    --platform linux/amd64 \
    --build-arg "PAPERCLIP_RUNNER_CONTENT_ID=${content_id}" \
    --build-arg "PAPERCLIP_RUNNER_SOURCE_REVISION=${source_revision}" \
    --file docker/daytona-runner/Dockerfile \
    --tag "$image" \
    --push \
    .
fi
docker buildx imagetools inspect "$image"
```

The content ID hashes the audited image inputs, including the Dockerfile,
platform, root package/lock/build configuration, dependency patches,
`paperclip-eval-kernel`, and `paperclip-runner`. Changes elsewhere in the
repository keep the same tag and reuse the already signed image. The Git SHA is
stored separately as image provenance. CI reads that provenance back from a
reused image when it builds the controller-side provider pack, preserving the
exact manifest match required to avoid restaging the pack into Daytona.

Resolve the manifest digest and set `PAPERCLIP_E2E_DAYTONA_IMAGE` to
`ghcr.io/paperclipai/paperclip-daytona-runner@sha256:...`. The repository
workflow signs that digest with Cosign/OIDC and verifies that it is publicly
pullable, includes the provider pack, and advertises `dial_ws_loopback`,
`dial_wss`, and `listen_ws`. The GHCR package must be configured as public;
the image job deliberately fails its anonymous-pull check otherwise. Existing
content tags are never rebuilt or overwritten by the workflow.

### Match the local controller package to the Daytona image

When the controller runs on macOS or another platform different from the sandbox,
set `PAPERCLIP_RUNNER_REMOTE_BINARY_PATH` to a verified Linux amd64
`paperclip-runnerd`, such as the binary copied from `/usr/local/bin/paperclip-runnerd`
in the pinned image. The controller must have these exact bytes for its artifact
identity check. A local macOS runner cannot substitute for the Linux binary,
even when the sandbox image contains a compatible runner. This also applies to
native Codex cells, which do not otherwise need the remote provider pack below.

Native ACPX (including Claude) and OpenCode Daytona cells also require
`PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH` on the controller. The package and
the image must come from the same verified build. Equal provider version numbers
are insufficient: verification compares the complete manifest, source revision,
Node executable, lockfile, and built bridge hashes. An independently rebuilt
package can fail that comparison and trigger a large upload before any model
work begins.

Prefer the hosted workflow: it builds the image and controller package together,
and uses the image's recorded source revision when reusing an image. For a local
run, use the immutable image from the campaign for the code under test and copy
its exact package. Do not copy credentials or change manifest fields to force a
match. Docker must be running; the temporary container below is never started.

```sh
(
  set -eu
  : "${PAPERCLIP_E2E_DAYTONA_IMAGE:?Set the verified immutable image digest}"
  case "$PAPERCLIP_E2E_DAYTONA_IMAGE" in
    *@sha256:*) ;;
    *) echo "Use an immutable image digest" >&2; exit 1 ;;
  esac
  docker pull --platform linux/amd64 "$PAPERCLIP_E2E_DAYTONA_IMAGE"
  pack_dir="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-e2e-provider-pack.XXXXXX")"
  container_id="$(docker create --platform linux/amd64 --network none \
    --entrypoint /bin/true "$PAPERCLIP_E2E_DAYTONA_IMAGE")"
  trap 'docker rm "$container_id" >/dev/null' EXIT
  docker cp "$container_id:/opt/paperclip-runner/provider-pack/." "$pack_dir/"
  test -f "$pack_dir/provider-pack.json"
  printf 'Set PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH to: %s\n' "$pack_dir"
)
```

Export the printed path in the shell that launches the eval. Runtime verification
still checks all package artifacts. The run log must show
`using manifest-matched provider pack from the sandbox image`; after reuse it can
instead show `reusing manifest-matched provider pack from the workspace`. A setup failure before provider
execution does not measure Claude recovery. Keep cold-upload coverage separate
from the recovery test, and retain mismatched or failed attempts as evidence.

## Evidence and cleanup

Packaged, access-controlled evidence is written beneath
`tests/runner-e2e/results/<campaign>/...`. Passing attempts include
`final-state.png`, Plan draft/revision screenshots when applicable, matcher
outcomes, sanitized fixture/API metadata, a result record, JUnit, HTML, and a
blob report. Failures additionally retain the Playwright trace/video, browser
diagnostics, failure screenshot, and sanitized Paperclip/run logs when
produced. WebM files remain limited to the local results directory and
access-controlled GitHub Actions artifact. Declared PNG screenshots are also
published with permanent campaign dashboards; fixture authors must therefore
keep credentials and other private data out of every captured UI state. SVG is
active content and is rejected from the packaged evidence entirely.

The standard task and chat evidence collectors read durable run events through the paginated
public API, including completion events beyond the first 1,000 rows. It rejects
missing, repeated, or out-of-order sequence numbers and fails capture after
100 full pages instead of grading a truncated stream. Original incomplete
captures remain failed evidence; qualifying a fix requires a new live attempt.

Every completed local campaign also writes
`tests/runner-e2e/results/<campaign>/dashboard.html`. The self-contained page
shows the complete profile/environment grid with screenshot thumbnails.
Expanding a case shows its matchers, pass/fail details, provider/model/runtime,
timings, token and cost accounting, and evidence links. The campaign header
aggregates input, output, and cached tokens, provider-reported LLM spend,
Daytona list-price runtime estimates, and pricing coverage. Missing provider
usage is labeled `unavailable` or `unpriced`; it is never presented as zero
cost. The CI report job stages the same portable site at
`normalized/index.html` inside the access-controlled merged report artifact.

The trusted publisher discovers display-only entries for selected execution IDs
absent from its local catalog, so branch-only suites remain visible in the
dashboard, filters, gallery, and summary image. It validates execution identity
and escapes display text without loading target-branch executable code. Unknown
suite cardinality is not treated as proof of full-suite coverage.

Permanent publication uses two explicit bundles. Both retain only normalized
result PNG files with the explicit `public-runner-fixture` publication marker,
including marked `failure.png` captures, so every campaign dashboard has its
screenshot thumbnails and gallery. The capture helper adds this marker only
for the reviewed runner fixture and blocks public capture outside the exact
issue route for the fixture that the harness created. A blocked failure capture
remains private. The CloudFront-backed S3
history also contains one publisher-generated
`public-images/campaign-summary.png`.
Trusted publisher code renders it offline from fixed catalog labels and
sanitized status/count/duration fields; provider output, error text, comments,
and target-produced pixels are never inputs. The PNG must pass a 12 MiB bound
and signature validation before entering the immutable manifest. S3 also
retains allowlisted inert per-attempt evidence (`.json`, `.log`, `.md`, and
`.txt`); `.log` copies have already passed exact-value/key-shape scanning and
redaction. The GitHub Pages bundle is regenerated separately with the same
declared-screenshot boundary.

Publication fails if any declared public screenshot is missing from the bundle.
The evidence packager explicitly retains `chat-plan-draft.png` and
`chat-plan-revised.png`; arbitrary chat-prefixed files remain excluded.

Both public bundles exclude video, archives, raw/unallowlisted logs, SVG or
other active content, generated Playwright/blob/HTML report trees, and
undeclared PNG files, and per-attempt XML. The root `junit.xml` remains public
because the report aggregator builds it from fixed markup and XML-escaped
fields. Full evidence remains available only in the access-controlled workflow
artifact.

### Billing interpretation

Each result contains raw sanitized `usage`, normalized `billing`, and
`runtimeUsage`:

- LLM token and dollar values come from the persisted heartbeat-run usage. A
  multi-turn case aggregates every selected run and records how many runs
  supplied tokens and provider-reported cost.
- Local execution records agent run time but is `not_metered` because there is
  no external environment provider charge to attribute.
- Daytona records every public-API lease window and its pinned 4 vCPU, 4 GiB
  RAM, and 10 GiB disk allocation. Its runtime dollar value is an estimate at
  the versioned public list rates in `billing.ts`, not an invoice amount.
  Credits, discounts, the storage allowance, and delayed billing adjustments
  can make the eventual Daytona charge lower.

`normalized-results.json` uses the v2 campaign schema and includes per-test,
per-suite, and overall billing. The compact `history.json` index retains the
same metrics per campaign/suite/execution, source SHA/ref, definition
fingerprints, completeness, retries, and cleanup. Trend charts compare only
complete campaigns by default; partial/manual selections remain browsable.
`summary.md` carries the current totals into the GitHub Actions job summary.
In CI, its **View results** section links to the exact immutable public campaign
report, the workflow and per-cell logs, and the access-controlled report
artifacts. Each cell name links to its exact section in the campaign report.
The public campaign links become available after the history publisher
finishes. The artifact links remain available for 30 days.

For a development branch that adds a suite, the trusted default-branch dashboard
may not yet include that suite's interactive cards. Its published `summary.md`
and `normalized-results.json` still contain every selected cell. Use those files,
the GitHub job summary, or `html/index.html` in the merged Playwright artifact
to inspect branch-only results; an absent dashboard card is not passing coverage.

Case details show the overall failure reason separately from behavioral matcher
results. For first-task cases, **Read full conversation** starts collapsed and displays retained
comments, question and approval cards, card answers, and document revisions in
time order, using Paperclip chat styling: user bubbles on the right, agent replies
on the left, and separate cards for questions and documents. This presentation
is defined in the shared dashboard renderer for every campaign and regeneration,
not in a particular published report. GitHub publication uses the trusted
default-branch renderer, so renderer changes take effect there after merge.
The shared static card renderer covers `ask_user_questions` (legacy and canonical
question sets), `request_confirmation`, `request_checkbox_confirmation`,
`request_item_verdicts`, `suggest_tasks`, and `connection_intent`. Confirmation
variants include tool actions, credential bindings, and connection authorization.
Cards display saved prompts, choices, recorded selections, outcomes, and reasons;
all action controls are disabled. Multi-question forms expand every question for
review. Unsupported kinds retain their raw payload instead of invented controls.

Repeated checkpoints are deduplicated. Source links open the original
checkpoint; evidence links expose the complete result and raw run/tool-event JSON.
The transcript reflects captured checkpoints; messages from other tasks and
unrecorded intermediate document edits may be absent. It is not a live task.

### Iterate on a published dashboard without rerunning paid tests

Download and extract the `github-pages` artifact from an existing workflow run,
then regenerate only its HTML from the retained `normalized-results.json` and
public structured evidence files. The Pages artifact has already had private
visual and generated report evidence removed:

```bash
gh run download <run-id> --repo paperclipai/paperclip --name github-pages --dir /tmp/runner-e2e-pages
mkdir /tmp/runner-e2e-site
tar -xf /tmp/runner-e2e-pages/artifact.tar -C /tmp/runner-e2e-site
pnpm test:e2e:runner:dashboard -- /tmp/runner-e2e-site
# Optionally use a downloaded history index:
pnpm test:e2e:runner:dashboard -- /tmp/runner-e2e-site --history /tmp/history.json
```

Serve that directory with any static file server. This path does not start
Paperclip, invoke an agent, create a Daytona lease, or consume provider tokens.

Before an access-controlled evidence artifact is uploaded, the launcher:

1. copies only allowlisted file types;
2. scans raw API snapshots before sanitizing them;
3. scans the closed Paperclip home/database and workspace as streams;
4. redacts loaded exact values and known provider-key shapes from text;
5. expands ZIP reports for secret scanning;
6. rejects SVG and other unsafe files and fails the cell if a leak is detected;
   and
7. verifies that a passing attempt has its final-state screenshot.

The temporary Paperclip home, embedded database, raw workspace, master key,
and unredacted logs are removed after confirmed cleanup. If process or remote
cleanup is unconfirmed, the harness retains the owner-only temporary root and
its recovery database for reconciliation; that private state is never packaged
as public evidence. Daytona teardown destroys
the environment and any reusable leases through the public API; provider-side
auto-stop/archive/delete values remain as cancellation backstops.

## Planning guidance utility

The explicit-only [planning comparison](PLAN-TASK-GUIDANCE.md) tests current, short,
and disabled planning skills across four saved business outcomes on native Codex.
It adds twelve single-attempt cells and does not expand `--all`.

## GitHub Actions

`Runner Full-Stack E2E` has only `schedule` and `workflow_dispatch` triggers; it
never runs for a pull request or ordinary push. Start the trusted workflow from
the default branch. A CODEOWNER can set the optional `target_branch` input to
any branch in `paperclipai/paperclip`. The authorization job resolves that
branch to one immutable commit before any checkout. A separate credential-free
job checks out the resolved commit and regenerates `pnpm-lock.yaml` once with
`--ignore-scripts --no-frozen-lockfile --lockfile-only`. It uploads that exact
lockfile under a run-attempt-scoped artifact ID and records its SHA-256.
Catalog, image, shared-build, provider-pack, and paid test jobs download the
artifact by ID, verify its digest, and restore it before setup or a frozen
install. The shared-build, provider-pack, and paid test jobs all disable
dependency lifecycle scripts, and provider secrets are introduced only in the
final test step. This permits an authorized target branch to exercise an
intentionally uncommitted workspace patch while keeping every target job on one
identical dependency resolution. The shared-build job compiles the selected
campaign's TypeScript outputs and native binaries once, then each paid cell
verifies and extracts the immutable bundle. Remote native cells similarly reuse
one verified provider pack. Report
sanitization and AWS history publication do not consume the target lockfile;
they explicitly check out and install from the trusted workflow commit. The
workflow definition, runner-group permission, and protected-environment
deployment still come from the default branch. Do not select the target branch
in GitHub's **Use workflow from** control.

Because this repository is public, manual campaigns fail before checkout unless
the trusted workflow runs from the default branch and both the original actor
and rerun actor have numeric GitHub user IDs in the non-empty JSON-array
repository variable `RUNNER_E2E_ALLOWED_ACTOR_IDS`. Keep this stable-ID list in
sync with the owners of `.github/**` in `.github/CODEOWNERS`. Usernames are
intentionally not trusted. The first scheduled attempt is trusted automation;
any human rerun of a scheduled campaign must pass the triggering-actor
allowlist.

For example, this command runs one branch cell through the trusted default-branch
workflow:

```bash
gh workflow run runner-full-stack-e2e.yml \
  --ref master \
  -f target_branch=fix/example \
  -f all=false \
  -f id=core-compatibility.runner-codex.local.message-marker
```

Create a protected `runner-e2e-paid` GitHub environment, restrict it to the
default branch, limit environment administration to trusted maintainers, and
store the four provider secrets there. This is a second authorization boundary:
the pre-check prevents unauthorized scheduling, while the environment prevents
secret release if the workflow gate is accidentally weakened. Also restrict
Actions to approved actions and require review of `.github/workflows/**` and
`tests/runner-e2e/**` through CODEOWNERS and branch protection. Manual inputs
accept comma-separated values for repeatable dimensions.

The nightly cron is `08:47 UTC`, but scheduled execution is intentionally gated
by the repository variable `RUNNER_FULL_STACK_E2E_NIGHTLY_ENABLED=true`. Set it
only after the live acceptance ladder in the architecture plan is green.
Set `RUNNER_E2E_AWS_ENABLED=true` to route paid cells to the repository-scoped
ephemeral AWS RunsOn fleet selected by
`runs-on/fleet=paperclip-public-pr-x64/env=public-ci`. Any other value uses the
proven GitHub-hosted `ubuntu-latest` target. Set `RUNNER_E2E_MAX_PARALLEL` to an
integer from 1–100 on AWS (default 100). The 171-cell default selection takes more than
one wave at that limit; use suite selectors for smaller campaigns. The fallback runner retains its 1–57 limit and
default of 32. Multi-turn steps are sequential inside their cell while
independent cells overlap. Artifacts and merged HTML/JUnit/normalized reports
are retained for 30 days.

Restrict the RunsOn fleet to this repository and independently trusted
workflows. Do not let untrusted pull-request or fork-triggered workflows target
it, and require a fresh ephemeral instance for each job so one paid cell cannot
leave state for the next. Provider secrets remain protected by the stable-ID
authorization checks and the default-branch-only `runner-e2e-paid` environment;
the fleet itself is not an authorization boundary. These external fleet controls
are as important as the workflow checks in a public repository. A CODEOWNER
dispatch is an explicit authorization to execute the selected repository branch
with the cell's scoped provider credential.

Development branch campaigns share a concurrency key per target branch and
cancel an older run when a replacement is dispatched. Default-branch target
campaigns are retained and are never auto-cancelled, preserving their audit
trail.

GitHub Actions artifacts are access-controlled 30-day operational copies, not
the permanent public history. They retain packaged PNG/WebM and generated
reports for debugging. Create a second protected `runner-e2e-history`
environment, restricted to the default branch and trusted environment
administrators, then configure these repository variables:

- `RUNNER_E2E_HISTORY_AWS_ROLE_ARN`
- `RUNNER_E2E_HISTORY_AWS_REGION`
- `RUNNER_E2E_HISTORY_S3_BUCKET`
- `RUNNER_E2E_HISTORY_PUBLIC_BASE_URL`
- optional `RUNNER_E2E_HISTORY_PREFIX` (default `runner-e2e`)

The job exchanges GitHub OIDC for short-lived AWS credentials; never add AWS
access-key secrets. Its IAM role must trust only
`repo:paperclipai/paperclip:environment:runner-e2e-history`, and permit only
Get/List/Put under the configured prefix—never Delete. Enable S3 versioning and
Block Public Access. CloudFront reads the private bucket through Origin Access
Control. Immutable campaign bundles live under `campaigns/<run-id>-<attempt>/`;
mutable `history.json`, `latest.json`, and `latest-green.json` are updated by a
globally serialized publisher. An existing campaign key with a different
bundle digest fails closed.

GitHub Pages remains the stable latest dashboard. Enable Pages with GitHub
Actions as its source and set `RUNNER_FULL_STACK_E2E_PUBLISH_PAGES=true`.
The publisher creates an S3 stage with the trusted synthetic summary PNG and a
separate Pages stage. Both surfaces publish only per-result PNG screenshots
with the explicit `public-runner-fixture` marker alongside sanitized structured
evidence. The runner capture helper refuses to mark a screenshot outside the
exact live fixture issue route. Neither surface publishes video, archives,
SVG/active content, databases, Paperclip homes, workspaces, raw/unallowlisted
logs, or credentials.

See [FIXTURES.md](./FIXTURES.md) before adding or changing a profile,
environment, task, matcher, or future Paperclip object fixture.
See [SECURITY.md](./SECURITY.md) before enabling paid dispatch, the runner
group, or permanent public history in this public repository.

## Automatic task titles

The explicit-only `task-titles` suite creates tasks in Chromium with an empty
title field. Its ordinary writing request contains no naming or tool directions:
the production execution prompt must cause the agent to call `set_task_title`.
Six local cells cover standard and Ask naming plus an explicit-title preservation
control on native Codex and Codex Mini. Each expects one provider run, has a
six-minute attempt deadline, and applies 500-cent company and agent budget caps.

The oracle captures the browser's original POST and creation response, then
requires a descriptive replacement title, cleared generation marker, unchanged
description/assignee, a correlated successful title call within the first five
tool calls of the initial run and before completion, and a matching agent/run
audit entry. Reloading the task must show the saved title and requested answer.
The control rejects even a temporary rewrite of a user-supplied title. A model's
claim that it renamed the task cannot pass. These cells require the dedicated
native tool; they do not qualify legacy/API-fallback naming or planning mode.

```sh
pnpm test:e2e:runner -- --list --suite task-titles
pnpm test:e2e:runner -- --id task-titles.runner-codex-mini.local.prompt-title-standard --max-automatic-retries 0
```

Only `OPENAI_API_KEY` is required; no Docker artifact oracle or Daytona is used.
Use one exact ID for a live smoke run. The existing harness owns fixture setup,
cleanup, source/model provenance, billing, failure classification, screenshots,
and reports. All runs in the isolated fixture are included in billing/cleanup.
Private attempt evidence adds `snapshots/task-title-creation.json` and
`snapshots/task-title.json`; public screenshots use the existing marked task
route and final-state capture. `task-titles.test.ts` calibrates correct evidence
against missing, fabricated, late, misattributed, and overwritten-title outcomes.

## Everyday user-story evals

See [EVERYDAY-WORKFLOWS.md](EVERYDAY-WORKFLOWS.md) for the explicit-only native-runner stories and their canonical Evalbook importer. These cells do not expand scheduled `--all` runs.

### Everyday hiring prerequisites and timeout evidence

The manual `everyday-workflows` / `hire-reuse` story enables native API tools in
its isolated harness and creates a personal managed AI account through the public
API. The lead uses the responsible user's default account, without adapter env
credential overrides. The hire must inherit that binding and finish a real run
attributed to the same account. The evidence records this fixture configuration.
Other suites retain their existing API-tool defaults.

A polling deadline after successful state reads is a candidate workflow failure,
not a reason to retry as infrastructure. State snapshots remain in the evidence;
the timeout message does not serialize task data into the failure classifier.
Explicit server-health waits and failed network reads retain infrastructure
classification.

The product execution prompt v3 tells agents to record child dependencies and
end the parent turn when no independent work remains. The user-story prompts
stay unchanged, so live retests measure the product guidance itself.

Delegated ZIP delivery can appear on the user-facing parent or its child task.
The grader selects the newest ZIP only within that task family; a reuse request
requires a new attachment after the request. The hired-agent execution/account
checks and independent downloaded-code checks remain mandatory.

Revision delivery checks exclude preserved originals by their content hash, even when the agent republishes an original after the revised ZIP. The browser downloads the exact selected attachment ID; its bytes still pass through the independent artifact checker.

## First-task onboarding

`first-task` is a suite in the main Runner E2E catalog. A full
`pnpm test:e2e:runner -- --all` run (or an unfiltered full GitHub Actions campaign)
includes its 52 executions alongside the other suites in one shared dashboard,
campaign result bundle, and history entry. Suite/profile selectors narrow that
same harness; they do not invoke a separate onboarding reporting program.

`first-task` uses the production onboarding wizard, creates the first agent,
keeps its default persona/model/permissions/skill assignments, and answers the
seeded opening question in the browser. The suite does not install the generic
Runner QA persona or replace the hidden `/first-task` invocation. Profile IDs
select the Codex or Claude adapter family; **the production onboarding model
default is retained**, even when it differs from that profile's normal harness
model. Configured and provider-observed model identities are reported separately.

There are thirteen cases on `legacy-codex`, `legacy-claude`, `runner-codex`, and
`runner-acpx-claude`, local only (52 cells). Native profiles complete the same
production wizard using their legacy provider, then change only the agent's
runtime configuration via the public API before its first task. The wizard does
not currently offer native Runner. Persona, managed instructions, skills, seeded
question, and task invocation are preserved. Explicit model choices are retained;
an unset model resolves through the production runtime-switch defaults. The
production switch removes the legacy Paperclip operational skill because Runner
supplies its control-plane contract through its protocol; other assigned skills,
including `/first-task`, are retained. Native runtime permissions come from the
existing qualified profile. Evidence labels
this setup `post-onboarding-runtime-switch`; it does not claim a native wizard
path exists. Legacy setup is labeled `production-wizard`.

| First response / control | Complete journey |
| --- | --- |
| `interview-first-response` | `interview-plan-accept` |
| `clear-task-first-response` | `task-card-accept` |
| | `accept-while-running` |
| `ambiguous-task-first-response` | `task-reply-accept` |
| `plain-message-first-response` | `clarify-propose-accept` |
| `plan-first-response` | `revise-accept` |
| `ordinary-task-control` | `reject-no-execution` |

The ordinary control creates a separate, normally assigned task for the same
onboarded agent without invoking `/first-task`. Fixed garden-club facts and a
per-attempt marker drive all conversations. Clarification supplies facts only;
acceptance is a separate explicit user reply or browser-approved confirmation.
The harness waits for a new user comment to persist before recording a reply
checkpoint; the composer clearing is only optimistic UI state.
The interview journey requests a saved plan. Execution journeys require exactly
one correctly parented/assigned subtask and its completed output document.
Rejection and revision must not execute the rejected/superseded scope. Closing
an unexecuted task after rejection is allowed. A completed onboarding parent
without the approved child is graded as a behavior failure, not retried as an
infrastructure timeout.

The refusal checkpoint records the persisted user decision before waiting for
the run to settle. A refusal that closes the task may end its responding run as
cancelled; this is allowed only with the exact saved user decision, the matching
issue/agent/comment wake, control-plane cancellation after the decision, a
Cancelled task, and a persisted response attributed to that run. The waiter
allows the response to arrive after cancellation. Missing responses, operator
cleanup cancellations, provider errors, unauthorized outputs, and active runs
still fail.
The response check proves persistence and attribution. It does not grade the
reply's wording; the saved task, output, and run state prove non-execution.

An obsolete queued wake with `issue_terminal_status` is not a provider failure
when `startedAt` is explicitly null and its issue is durably Done or Cancelled.
All other run and outcome checks still apply. Run rows and billing are retained.
Chat clarification accepts concrete information lists introduced by "I need:"
without requiring a question mark, while work checklists, empty requests, and
lost task ownership remain failures. These grading rules are versioned in each
affected suite's definition metadata; they do not retroactively qualify aborted
historical attempts.

`question-choice-options` fails any recorded single-select or multi-select
question with fewer than two distinct, nonempty options, including one-option
"I'll describe it" forms. It checks every captured card presentation, including
later and superseded cards, and reports the question ID, prompt, option count,
and checkpoint. Canonical `answerMode: "text"` questions are valid without
options. A text field or implicit Other fallback does not add a choice to a
canonical select question.

The first-task suite does not scan private instance homes or workspaces for
credential persistence or use that check to override behavioral results.
Credential persistence is evaluated elsewhere. Evidence redaction and public
artifact checks still apply.

Behavioral checks inspect persisted comments, interactions, tasks, documents,
agent counts, creation timestamps, and terminal runs. Planning and clarification
are allowed before acceptance. Premature durable work fails immediately. The
suite checks persisted Paperclip effects; it does not claim to prove the absence
of arbitrary external side effects from a provider process.

```bash
pnpm test:e2e:runner:unit
pnpm test:e2e:runner:typecheck
# Two paid smoke cases, after keys are available:
pnpm test:e2e:runner -- --suite first-task --profile legacy-codex --case clear-task-first-response
pnpm test:e2e:runner -- --suite first-task --profile legacy-claude --case clear-task-first-response
# Expand after reviewing the smoke evidence:
pnpm test:e2e:runner -- --suite first-task
```

Default concurrency is one. Each case has a fifteen-minute attempt budget;
individual response/outcome waits stop after five minutes. More than twelve
company runs fails the case. All company runs (including delegated/child-agent
work and failures) are retained for cleanup and billing. The existing failure
classification separates transport/credential failures from behavior failures.
First-response cases stop when the first provider turn settles.

`snapshots/first-task.json` contains full managed instruction/skill snapshots and
SHA-256 source hashes (plus separate display hashes when redaction applies), the actual hidden invocation and seeded greeting/question,
source SHA/ref and dirty state, runtime settings, observed models, checkpoints,
and check results. `first-task-run-evidence.json` retains run logs/events. The
normal screenshots, sanitized evidence packaging, dashboard and publication
commands apply. Dashboard task/document links target retained evidence because
isolated instances are removed after each attempt.

### Optional quality post-processing

Quality is informational. It cannot turn a behavioral failure into a pass.
The five anchored 1–5 dimensions are question relevance, use of facts, proposal
usefulness, clarity, and low friction. Every score must cite a recorded
checkpoint. The judge reads only recorded conversation/state, has no tools,
and never participates as a simulated user.

Run judging on each **upload-directory `result.json` before normalization and
publication**, with `OPENAI_API_KEY` in the shell:

```bash
pnpm test:e2e:runner:judge-first-task -- --result tests/runner-e2e/results/CAMPAIGN/EXECUTION/attempt-1/result.json --max-dollars 0.50
```

Use the actual upload path printed by the launcher. The judge uses the pinned
`gpt-4.1-2025-04-14` snapshot, temperature zero, and at most 1,800 output tokens.
The configuration, rubric, hash, evidence hash, usage, price estimate, and full
reservation are recorded. Rates are pinned at $2/M input and $8/M output tokens
([model documentation](https://developers.openai.com/api/docs/models/gpt-4.1)).
A conservative UTF-8-byte token bound checks the per-call spending cap before
sending. Oversized evidence is rejected, never truncated. An exclusive adjacent
`result.json.judge.json` ledger prevents concurrent/repeated spending; failed or
interrupted requests retain their reservation and are not retried. Unknown
usage is not reported as free. Judge spend is shown separately and included in
total estimated spend when known; provider/child usage stays in the run ledger.

Regenerate normalized reports with the existing report command, pointing
`PAPERCLIP_RUNNER_E2E_REPORT_ROOT` at that campaign,
`PAPERCLIP_RUNNER_E2E_REPORT_OUT` at a fresh output directory, and
`PAPERCLIP_RUNNER_E2E_EXPECTED_IDS` at the JSON array of selected execution IDs.
Then use the existing dashboard/history publication workflow. Merely running
`test:e2e:runner:dashboard` reads the already normalized bundle; it never calls
a judge or refreshes results from outside that bundle. Published campaign
bundles remain immutable; judge them before publishing.

### Comparing skill revisions

Use separate campaigns for each skill revision and three repetitions per
case/provider (144 executions per revision), keeping source environment,
provider/default model, credentials mode, case facts, and judge configuration
matched. Set distinct `PAPERCLIP_E2E_CAMPAIGN_ID` values such as
`first-task-skill-a-r1` through `r3`, and repeat for skill B. Review actual model
identities and instruction hashes before comparing; dirty working trees are
explicitly marked. Do not pool results with mismatched configurations or treat
infrastructure failures as behavioral successes. Daytona,
simulated-user models and prompt optimization are intentionally deferred.


`accept-while-running` clicks a confirmation as soon as its source run exposes
one, without the usual wait for that run to settle. It retains the normal
acceptance, child-task, duplicate-work, and durable-output checks. The additional
`accepted-while-running` matcher compares the persisted card resolution time
with the source run's start and finish times. If the model finishes before the
click lands, the case is unexercised, never a passing concurrency regression.
Provider-free route tests also hold a real child process open to exercise this
interleaving deterministically for confirmations, checkbox approvals, and answers.

### Task continuation

The `continuation` suite is included in full (`--all`) campaigns. It adds five
local cases for Legacy Codex, Legacy Claude, Runner Codex, and Runner ACPX Claude
(20 cells): authenticated answers changing scope, clarification without approval,
scope revision preserving approval, untrusted handoff text read through a real
tool, and completed child-task reuse across a server restart.

```sh
pnpm test:e2e:runner -- --suite continuation --profile runner-acpx-claude
```

User requests and replies are fixed; the driver submits them through the task UI.
The fixtures use production completion/tool instructions, not fixture-specific API
recipes. Deterministic checks inspect saved documents, child IDs, statuses,
attachments, and settled approval checkpoints. `continuation.json` records each
checkpoint and matcher; private `continuation-run-evidence.json` contains the
recorded provider logs and events. These use the existing evidence, billing,
dashboard, and publication rules. Raw logs remain private.

Continuation cells have one attempt and verify 1,000-cent company and agent
budget hard stops before creating the task. No automatic reroll is admitted.
At every recorded wait, the lifecycle oracle requires the same task and assignee,
an actionable pending interaction, and no scheduled retry, recovery or monitor.
A settled turn must leave the task in review with its execution lock released.
A provider-native question can instead retain a running native run and lock when
the pending runtime request identifies that exact run. All intermediate run IDs
and all pending question identities must survive to the final snapshot; every
question must be answered exactly once in the retained interaction list.
Checkpoint activity records support inspection of successful persisted mutations.
They do not count failed API/tool attempts or establish a general no-duplicate-write
guarantee. See the [waiting/resume ownership audit](../../doc/plans/2026-10-08-wait-resume-ownership.md)
for boundaries and remaining instruction decisions. Historical results keep their
original grades when these assertions change.

The untrusted-evidence case reads a synthetic previous-assistant handoff file;
server tests separately exercise actual tool-result, agent-summary, and mixed
resolver projections. This is a regression sample, not an exhaustive injection
or authorization evaluation.

The native-only `question-tool-documentation` case adds two cells (Runner Codex
and Runner ACPX Claude), for 23 continuation cells total. It asks for a clickable
Morning/Afternoon question, followed by an open text question, then a saved note
using both real answers. The user prompt contains no tool names or payload recipes.
Checks inspect actual forms, ordered UI answers, the saved document, and every
recorded native task prompt: the short routing sentence must remain, while the old
question section and detailed tool-format instructions must be absent. Server
contract tests separately verify that the advertised tool carries the documentation
for fresh and resumed native executions. This tests the current documentation
placement; it is not a statistical comparison with the former prompt arrangement.

The separate explicit-only `question-resume` suite uses the same neutral two-question
request on native Codex and ACPX Claude. It qualifies the user journey through
either the provider's built-in question or Paperclip's semantic question tool.
It does not replace or regrade `question-tool-documentation`.

The oracle classifies each wait from its exact task/agent/run identity. Provider
questions require the server-generated request key and retain the paused run.
Semantic questions require an applied `request_human_input` receipt and one new
response wake bound to that interaction and source run. Only a verified provider
choice may carry the adapter's optional Other field. A second substantive question
is still rejected; the subsequent reference question must be text-only. Both real
board answers must remain bound to unchanged forms, and one saved document must
include both answers. Existing lifecycle, ownership, premature-output, terminal
state and no-extra-task checks apply. Three checkpoints are required even when
both answers resume one run; missing native inputs or unexplained runs fail.

Select `question-resume.runner-acpx-claude.local.question-answer-resume` for the
bounded Claude qualification. The suite is excluded from `--all`; it allows one
attempt, one to three actual runs, a ten-minute cell deadline and verified
1,000-cent company/agent hard stops. The historical failure where the optional
Other field stopped the driver before any answer remains a FAIL. A new behavior
pass does not establish semantic-tool selection, documentation placement, default
hiring behavior or general reliability.

Continuation screenshots wait for the correct task heading and fully revealed
conversation before capture. A loading screen or wrong task fails capture.
Browser-only regressions exercise delayed rendering without provider calls:

```sh
pnpm test:e2e:runner:browser-support
# To use an installed Chrome instead of Playwright's Chromium:
PAPERCLIP_PLAYWRIGHT_CHANNEL=chrome pnpm test:e2e:runner:browser-support
```

### Native provider continuity

The first-task `task-reply-accept` and `task-card-accept` journeys also verify that
ordinary native follow-ups retain the parent task's workspace, native session,
and provider session identities. A generic `sessionReused` flag is insufficient.
The check excludes child runs and applies only to native profiles.

For ordinary native comment and child-completion wakes, a verified provider resume
receives only new attributed messages, the current authenticated interaction result,
actual task edits, child results, and completion-report identifiers. The provider
retains conversation history. Paperclip retains task state and authorization. A new
or replacement session still receives the full bootstrap; specialized recovery,
review, external-chat and planning paths retain their existing context. Legacy
adapter prompts are unchanged.

The ACPX Claude-only `provider-question-bridge` case exercises the provider’s built-in question tool, verifies that its card appears in Paperclip, answers it in the browser, and requires the same paused run to finish with the selected fact. The `accept-while-running` fixture holds the committed card’s creation response until browser acceptance, making the overlap deterministic without changing production behavior.

Local Legacy Claude cells qualify Claude Code `2.1.277` before starting the server.
If the ambient CLI differs, the harness installs the exact version under the
attempt's temporary root and prepends that private bin directory to the server's
PATH. It does not change the developer's global installation. The old workflow
pin, `2.1.19`, did not discover `.claude/skills` supplied through `--add-dir`;
a provider-free CLI probe reproduced the missing skill on that version and
confirmed discovery on `2.1.277`. The workflow pin and local qualifier are checked
together. This change applies to local cells; Daytona images remain separately pinned.
Continuation question flows also wait for the submitted interaction's durable
`answered` state before considering the next checkpoint ready.

### Worker prerequisites

The trusted default-branch workflow provisions the local Codex sandbox for both
native Codex and ACPX Codex. It prepares the pinned Python artifact oracle only
for everyday stories that execute a downloaded ZIP; skill creation and service
questions do not need that oracle. Catalog coverage tests keep this list aligned
with the test flow. Native provider runs do not require an unrelated host
`claude` or `codex` CLI for version probing.

Changes to privileged worker setup must reach the default branch before a
branch-targeted paid campaign can exercise them. The report job resolves its
lockfile from its own trusted checkout, never from the tested branch.

### Injected interruption diagnostics

The restart supervisor starts Paperclip with the TypeScript loader in the same
Node process it owns. A forced stop therefore cannot leave an old controller
alive to stop the embedded database after the replacement starts. On Unix, the
server has its own process group so Playwright's wrapper-group shutdown cannot
signal it independently. Signal handling, restart cleanup, and final cleanup
share one stop operation per server: one graceful signal, a 30-second wait, then
SIGKILL to revalidated owned groups and a 5-second exit wait if needed. The
wrapper retains observed descendants across an early server exit and checks
PID/start identity before group signals. A failed cleanup can resume its saved
phase without another graceful signal. Windows retains direct-child signaling.
This prevents a second graceful signal from interrupting asynchronous warm-session
retirement.

Launcher cancellation first signals its outer group, so Playwright and the wrapper
own graceful server shutdown. It allows 45 seconds for that chain before bounded
5-second forced cleanup of revalidated descendants. Normal launcher exit uses the
same retained descendant inventory. Zombies count as stopped; an unavailable or
uncertain identity inspection triggers bounded direct-child-only retirement and
still fails the tree audit. Failed cleanup preserves the temporary state. Graceful
owners are selected from the same validated table used for delivery; ESRCH allows
selection of a surviving owner, while a delivered signal covers that owner's
existing descendants through the grace window even if the owner exits first.

Everyday restart and Stop scenarios exempt only their recorded cancellation,
graceful-shutdown interruption, or process-loss outcome. A later adapter error
on that same run still fails immediately and fails the lifecycle grader. The
run ID alone is not an exemption from recovery failures.

The review-handoff case also requires proof that the parent was blocked before
the review wake. When all tasks finish and persisted timestamps prove that the
accepted review started before any parent run finished, the harness fails
promptly with an unexercised-boundary diagnostic. Missing evidence in separately
fetched snapshots does not trigger this rejection. Successful work alone does
not prove that this recovery path was tested.

The native `agent-chat.create-backlog` case saves a plan and assigned backlog task, then asks for its status. It checks the original creation audit, absence of all task runs, plan persistence, and exactly one task, so creating runnable work and correcting its status afterward fails the eval.

### Remaining native Agent Chat qualification

`agent-chat-qualification` is an explicit-only, local suite with six cells:
`active-reassignment`, `worker-crash-retry`, and `grounded-answer-quality`, each
on native Codex and native Claude. Run with
`pnpm test:e2e:runner -- --suite agent-chat-qualification`.

Active reassignment waits for a real worker to save a draft and enter a bounded
file wait. The lead then transfers the same task through Agent Chat. The oracle
requires cancellation with `issue_reassigned`, no overlap with the successor,
one successor run, unchanged scope and plan, retained draft, and a completed
successor-owned document. It budgets three provider runs.

Worker recovery requires Linux with Python pidfd support (as on the CI workers).
It kills only the exact running native worker PID from the public
run record, after verifying its command-line run ID, process start identity, and isolated
local workspace. The signal uses an owned pidfd so PID reuse cannot retarget it.
The UI must preserve the plan and withhold generic Retry while cleanup remains
quarantined; the public retry API must return 409 without admitting another run.
The fixture then releases the read-only brief wait and sends a new chat message
that records the known saved-plan and interrupted-command outcomes. The server
must verify that the recorded worker and provider process groups stopped before
admitting exactly one successful fresh session. The answer must contain the
reference supplied only after the crash, and the saved plan must remain unchanged. The old quarantined run must not regain
a misleading Try again control after the fresh turn succeeds.
This qualifies **explicit conversation continuation after local worker loss**.
It does not qualify replay of uncertain actions, automatic recovery, remote worker
loss, or exact-session resumption. It budgets two provider runs. Unexpected
failures remain fatal; only the positively identified injected-fault run is exempted.

Answer quality uses two read-only turns over public fixture tasks and conflicting
historical comments. Exact structured propositions grade current blockers,
backlog versus active work, stale claims, and unknown facts. The written answers
and source records are retained for separate semantic review of factual grounding,
correction, uncertainty, usefulness, and clarity. Deterministic facts do not certify
all prose quality. This case explicitly enables the existing experimental API
context tools; the two recovery cases use the default native tool surface.

All cells have a 15-minute deadline. Evidence includes boundary and final run
records, documents, source facts, chat comments, and screenshots. Gates are
released on failure and normal isolated-instance cleanup removes the workspace.
The usual provider billing and partial-attempt reporting apply. No production
prompts, onboarding defaults, or provider permissions are changed.

For pre-default native onboarding qualification, select all `first-task` cases
with profiles `runner-codex,runner-acpx-claude` (26 cells). The existing public-API
runtime switch occurs after the real wizard creates its first agent and before
any provider work. It preserves the wizard's model, persona, skills, and task.
This tests the native first-task process in advance of the UI/default rollout;
it does not certify a native option in the wizard, which is not offered yet.

Current proof and remaining decisions are recorded in
[the 21 September qualification report](QUALIFICATION-2026-09-21.md). In particular,
the original worker-loss attempts quarantined both providers. The version 9 crash
eval requires a usable fresh conversation after verified cleanup. A passing
quarantine guard alone is not a recovered workflow.

### Blank-page investigation

Private `browser-diagnostics.json` includes the final document readiness, whether
`#root` mounted content, whether a service worker controls the page, outstanding
script/style paths, and recent module 304/error statuses. These fields contain no
response bodies, headers, or query strings. A 304 is ordinary cache validation;
recording it does not change the grade or retry the page. The public report still
uses the existing evidence allowlist.

The provider-free `tests/e2e/task-reload.spec.ts` regression opens a persisted task
with the production service worker, navigates to the same URL, and reloads it. It
requires the saved content and usable composer to remain visible. Run it with the
standard `tests/e2e/playwright.config.ts`; no provider or Daytona credentials are
needed. Browser-support tests separately exercise blank-root/pending-module
failure evidence, so a future blank page is distinguishable from a loaded task.

The HTML entry also supplies recovery before React mounts: a failed module shows
`Reload page`; a startup with no rendered root for 30 seconds offers the same
manual retry. Late successful startup removes the notice. It never reloads
automatically, and the notice lives outside `#root`, so it cannot satisfy an
app-readiness assertion. The saved-task regression interrupts the built bundle,
clicks retry, and verifies the original task, persisted comment, and composer.
`pnpm test:e2e:runner:browser-support` also tests failed and stalled imports,
evaluation errors, service-worker-controlled retry, repeated offline retries, and
cleanup after startup. The worker returns a static, uncached HTML retry screen
when a navigation fails offline; it never embeds or caches task content.

These fault-injection tests prove recovery from interrupted startup. They do not
establish the cause of the historical intermittent Vite module-graph stall;
ordinary 304 responses and successful reruns alone are not evidence of that cause.

### Grok Build qualification

`runner-acpx-grok` uses native ACPX with Grok Build 1.0.13 and `grok-4.7`.
Set an explicit `XAI_API_KEY` for this API-key profile. The manual
`grok-qualification` suite runs the core and restart workflows on local and
Daytona runtimes. The separate manual `grok-subscription-qualification` suite
uses `runner-acpx-grok-subscription` and explicit `GROK_AUTH_JSON`. Its fixture
stages that login in a private, disposable company home; this is credential
setup, not a test of interactive browser login. The server never inherits the
JSON secret or an API key from the harness. See [FIXTURES.md](FIXTURES.md) and
[SECURITY.md](SECURITY.md) for staging, cleanup, and redaction requirements.
Missing subscription coverage remains a qualification blocker;
an API-key pass must not be reported as subscription evidence. See
[`doc/grok-native-runner.md`](../../doc/grok-native-runner.md) for installation,
credential boundaries and repetition requirements.

### Grok branch qualification on EC2

The trusted default-branch workflow can run the explicit `grok-qualification`
suite from a selected target branch. Store `XAI_API_KEY` only in the protected
`runner-e2e-paid` environment. The paid step delivers it only to a profile whose
credential name is `XAI_API_KEY`. The Grok `build-revise` cells prepare the same
pinned Python artifact verifier used by Everyday Workflows, before credentials
are exposed. Local Grok cells also run the checksum-verifying binary installer
before receiving credentials. With `RUNNER_E2E_AWS_ENABLED=true`, the controller, browser and
artifact verifier run on the existing EC2 fleet; no developer laptop Docker
service is required. Set the optional `max_parallel` dispatch input to `1` for
keys with low request limits. It can only lower the configured campaign limit.
Keep subscription qualification separate from API-key results.

The explicit-only eight-cell [continuation accounting baseline](CONTINUATION-ACCOUNTING.md) tests productive work, bounded repair, restart and late gates with real providers.

### Bounded API response reading

`api-response-reading` is an explicit-only, two-cell native Codex suite (local
and Daytona). Each cell creates synthetic diagnostic evidence over 24 KiB via
the public API, outside the agent assignment. The browser starts one ordinary
task which must read the saved response in bounded text pages and persist the
exact hidden evidence code. The oracle also requires completed API tool events;
missing events or a narrative completion cannot pass. Existing run, copyback,
screenshot, billing and environment cleanup checks apply. Use
`--id api-response-reading.runner-codex.daytona.saved-text-pages` with an
immutable Daytona image; no private hooks or fixture database writes are used.

## Extended ACP harnesses (explicit only)

Copilot protection qualification requires a successful `get_task_context` read
before the tested native action. The v3 completion oracle independently joins
its read-only native lifecycle, authoritative result receipt, and canonical tool
events. It then validates the single finish receipt, accepted result, attached
command exit, and cleanup. The retained v15 context/completion fixture preserves
the original failed grade; its context receipt cannot stand in for completion.
Extra semantic actions and missing, late, failed, or mutating context reads fail.
The authored pending-permission Stop and provider-death prompts require the
already-exposed dedicated `get_task_context` tool directly before the native
edit. `search_api` discovers HTTP routes rather than semantic tools; `call_api`
and a context-like HTTP response cannot replace the dedicated context receipt.
Historical bounded discovery proof remains attested separately and cannot
establish context access or completion.
The denied-write prompt uses that same dedicated-context guidance.
The provider-death final UI assertion accepts the current Blocked label with
its blocker-attention explanation. The API settlement still requires exact
`blocked`, one failed run, no mutation replay, stale-answer refusal, and cleanup.

`--suite extended-harnesses` declares 30 Product E2E cells: Cursor, Copilot,
and Pi on local and Daytona, each exercising authenticated completion,
question/answer continuation, revision-bound semantic plan approval, restart
with pending input, and file edit plus independent byte validation. The file
case uses a public project workspace so Daytona copy-back is graded too.
These are candidate definitions, not a claim of provider qualification. Native
provider-specific questions, plan decisions, restrictive permissions and steering
need their separate conformance/qualification evidence.

```sh
pnpm test:e2e:runner -- --list --suite extended-harnesses
pnpm test:e2e:runner -- --id extended-harnesses.runner-acpx-pi.local.hello-complete
```

The suite is excluded from `--all`, and candidate cells never automatically
retry. Select one cell first, reserve its spend and reconcile provider billing
before another attempt. Existing subscriptions/credits and incremental cash
charges are separate; unavailable receipts do not mean zero cost. The September
28 qualification budget is $100 total including retries and Daytona resources:
$25 per provider and $25 coordinated infrastructure/diagnosis.

The launcher binds only the selected candidate and exact discovered model in
`PAPERCLIP_RUNNER_ACPX_QUALIFICATION`, a JSON array of `{agent,model}` pairs.
The server reads this operator environment at its normal runnerd construction
boundary; agent config/environment cannot enable qualification. Normal hosts
have no admission override. It does not bypass profile, executable, credential,
company, tool or permission checks. Keep this variable confined to isolated
qualification instances. Model catalog discovery alone does not prove inference
entitlement; all three profiles remain pending until the required live evidence
passes. Cursor and Copilot models are the explicit September 28 authenticated
discovery choices; Pi imports its production profile's fixed OpenRouter model.

Run each candidate from its provider branch, with its verified candidate assets
materialized under the runner package, and build the TypeScript sidecar before
local execution. Daytona additionally requires that branch's immutable Linux
candidate image and the matching controller-owned provider pack described in
[`docker/daytona-runner/README.md`](../../docker/daytona-runner/README.md).
The separate Runner Evals `extended-harnesses` campaign lives in the private
`paperclip-evals` repository and grades semantic protocol behavior against the
mock control plane. Neither suite substitutes for the other.

### Pi native Product fixtures

The separate `pi-native` suite defines ten explicit Pi cells: native questions,
agent-file persistence, browser permission denial and controller restart with an
unanswered native question on local and Daytona, plus
a local-only automatic `restrictive-denial` case and one Daytona-only
`native-pending-provider-death` case. The latter cannot use the remote
setup read under `deny-all`, so it is explicitly excluded there. It uses the
pinned candidate profile and exact OpenRouter model. It is excluded from `--all`,
never automatically retries, and retains qualification as pending until live proof.
Reserve and reconcile each paid cell just as for `extended-harnesses`.

Provider death is a real, one-run paid Product journey, distinct from controller
restart and Stop. The owned Linux observer pins the verified wrapper ancestry,
closure and executable inode before signalling exactly its unique Pi child through
a pidfd. Pi overwrites its argv with `process.title`; entrypoint attribution is
explicitly parent-attested, not an original-child-argv claim. The fixture requires
production-generated non-replayable expiry, an expired original browser card,
rejection of stale answers by both public APIs, no continuation file effect, and
no second run. Any durable `wake_assignee` fallback stays separately identified
and unanswered. Full process/run/lease evidence remains private. Local provider
death is excluded because this exact ownership mechanism requires Linux pidfd.
The Python helper calibration uses a synthetic transport and a real title-changing
Node child; it proves fault ownership only, never paid Pi lifecycle behavior. Run
it on native Linux with pinned Node on PATH: `python3 tests/runner-e2e/pi-provider-fault.test.py`.
The calibration covers direct launch and the production bootstrap's held FD 3
and FD 7 launches. Descriptor launch requires the held descriptor and wrapper
executable to match the sealed snapshot Node inode; an argv alias alone grants
no authority. Native suite definitions 6 retain the original live failures and
require new provider-death qualification after this fixture correction.
The fault helper validates the profile pin against canonical normalized closure
entries, matching production admission. JSON formatting is not part of that pin.
The same free suite checks canonical hash admission, malformed metadata and
changed entries before any signal is sent.
This adds one cell to the pending Pi Product matrix (26: 13 local, 13 Daytona);
no qualification or live success is implied by discovery or oracle tests.

```sh
pnpm test:e2e:runner -- --list --suite pi-native
pnpm test:e2e:runner -- --id pi-native.runner-acpx-pi.local.native-questions
```

Native questions exercise the runner-owned `paperclip_native_question` tool and
the durable browser form bridge. The existing five extended-harness journeys
continue to prove semantic Paperclip questions and planning separately. Personal
file persistence uses two fresh task runs and independent byte checks; restrictive
denial uses one run and requires both a failed tool receipt and no file effect.
The first managed-file API response is saved before its byte assertion, including
when the final LF is missing. An incomplete remote terminal receipt retains only
validated completion flags, watcher counts, process counts and target hashes.
Raw RPC fields and file bodies are omitted. These diagnostic records do not
change a failed byte or retirement grade and do not justify an unchanged retry.
`human-permission-denial` additionally requires the exact browser Decline response,
delivered native denial and independent file/process observation through retirement.
The restrictive Daytona fixtures approve only the exact operator-published
setup-file read after observer arming. They retain its public resolution and
completed native read before testing the separate write permission. This setup
approval does not change production policy or answer the tested write.
See [the fixture contract](FIXTURES.md#pi-native-boundaries) for the exact oracles
and the limits of reconnect evidence.

The manual `copilot-protection` suite selects two Copilot candidate cases on
each of local and Daytona (four cells). Discover them with `pnpm test:e2e:runner -- --list --suite copilot-protection`.
The denial case keeps provider-turn settlement separate from controller run Stop.
A normal provider completion observed by API before Stop dispatch is not active-turn
cancellation coverage; denial, no-effects, run cancellation and retirement remain
required. Earlier failed attempts retain their original grade.
See [Copilot native protection](./FIXTURES.md#copilot-native-protection) for the
expected cancelled negative test, finite attached-process oracle, evidence limits,
and required rebuilt runtime. Registration is not a qualification claim.
Copilot protection suite definition v6 clarifies the async marker as a private
diagnostic sentinel. Separate negated bootstrap sentences avoid an unintended
file-delivery objective; immediate completion stress and strict one-command and
settlement checks remain unchanged. Historical v5 failures are not regraded.

Local human-denial cases for Copilot, Cursor and Pi create a fresh fixture-owned
`pc-denied-*` directory before dispatch and watch its parent identity throughout
the attempt. This keeps unrelated workspace startup writes outside the target
watch. Exact prompt/native target correlation, complete watcher coverage and
zero target mutations remain required. Evidence includes coverage failure
reasons, parent device/inode changes and a bounded timestamped event journal;
an absent final file cannot hide an incomplete watch or transient mutation.
Remote cases retain their existing sealed observers.


### Cursor native interactions (candidate)

The explicit-only `cursor-native` suite has eight local/Daytona cells exercising
the native Cursor
question callback, plan rejection/revision/acceptance, plan cancellation, and
permission denial across browser reload. List it with
`pnpm test:e2e:runner -- --list --suite cursor-native`. The fixture configures
`acpxSessionMode` before the run: Plan for question/plan callbacks, Agent for
write denial. Native request origin, exact decision bytes and post-write
response delivery are required; semantic-tool interactions do not satisfy these
checks. The denial case also requires independent filesystem observations and
an API-bound process journal after provider retirement, before workspace
removal. Complete server and database cleanup remains the outer supervisor's
responsibility. These cases remain unqualified until paid runs pass.

The full native plan text is retained in the interaction card. Exporting a plan
file from Cursor's private HOME as a downloadable Paperclip artifact remains a
separate capability gap; these callback tests do not claim that export works.


### Remote native evidence and warm continuation

All three native suites use an operator-published instruction file to withhold
actual work until independent observers are armed inside the exact owned Daytona
sandbox. The initial task only reads that file. Explicitly typed setup reads are
separate from the native operation under test; unknown or extra writes/commands
still fail. SDK 0.203.0, immutable image and executable digests, public run/lease
ownership, sandbox labels and workspace sentinel are verified before execution.

Bootstrap admission uses the existing authored case deadline, including cold
snapshot provisioning, with a 64-second minimum setup reserve subtracted before
admission: 10 seconds for lease revalidation, 12 for the runtime-ready RPC,
27 for installation, and 15 for teardown. A lease discovered later is not admitted
with only installation/teardown time left. This does not impose a separate
20-second lease deadline or extend the case budget.
After lease admission, a read-only probe waits for the exact pinned runner
process and runtime directory before installing the observer once. This uses
the remaining case budget while preserving 27 seconds for installation and
15 seconds for teardown. Installation and the first observation recheck the
same process and directory identities before releasing the task instructions.
Startup evidence retains only closed RPC phase/error codes; detached observer
stderr is not collected, and a failed installation is not retried.
Every poll rechecks task/run ownership and run status, and requires exactly one
unambiguous active lease for that run and task. A stopped run fails as soon as its read completes, even if another endpoint
fails or remains pending. At most three reads are outstanding, each with a
transport timeout bounded by admission and 30 seconds. Late responses cannot
change saved evidence or start another poll. Missing reads
cannot admit a lease; successful ownership/status reads are retained.
Admission and observer setup failures save bounded, allowlisted read status,
run-stage, lease-count and classified read-failure evidence;
this evidence does not infer a provider-side cause. Admission GET failures are normalized once to fixed endpoint labels, generic
messages and explicit failure classes. Typed HTTP status and pinned transport
timeout shapes preserve infrastructure classification without response bodies,
URLs or original cause chains in thrown errors. Malformed responses never admit. A recovered API failure does
not reclassify a later successfully observed state timeout.
The initial provider's instruction-file read window remains 20 seconds after
provider startup, and no action is published before the observer is armed.

The observer watches registered targets (including transient create/delete), user
workspace changes and the exact runner process plus descendants. The single
controller-owned `.paperclip-runtime/paperclip-runner` subtree is excluded from
user-file inventory and mutation counts: it holds the binary, provider pack,
context, active runtime state, and sandbox GitHub launchers, upload locks and
per-command configuration. Launcher restaging after controller recovery uses
that same runtime path. SSH and local launcher locations remain separate.
Its location and identity remain checked, and
test targets cannot use it. This exclusion is recorded in evidence; it does not
claim that runtime-internal writes are covered by the user-file oracle.

A sealed receipt and bounded file bytes must reach the host before lease cleanup.
Missing receipts, incomplete watches, ambiguous or reused process identities, and
unproven retirement fail the cell. Sandbox deletion and host file copy-back cannot
substitute for remote proof. The observed PRP environment identifier is retained
as unverified metadata; the remote process is bound through the exact sandbox,
run ID, lifecycle, process group and executable digest. Same-UID observer isolation
is not an adversarial operating-system sandbox test.

Directory notifications remain counted. A notification for an existing directory
preserves completeness only when its device/inode still match an already
registered recursive watch. Newly created directories, replacements, symlinks,
and unknown notifications remain incomplete. Pi native definition v13 also gives
memory content a single JSON representation, including the required final LF;
the exact managed bytes and fresh-task readback assertions remain unchanged.

Pi native definition v14 seeds `memory/.pi-e2e-parent.txt` through the public
managed-file API before task admission. This creates the watched parent while
leaving `memory/pi-native.txt` absent; the native write still has to supply all
33 bytes and both turns must preserve the setup file. New or replaced watched
directories still fail the oracle. Closed incompleteness reasons identify watch
gaps or process ambiguity without retaining paths or raw errors. An incomplete
receipt remains failed. A validated terminal receipt with a captured, retired
process tree closes its observer without another RPC to a publicly deleted lease
only when evidence is complete or its failures are known filesystem-watch gaps.
Unknown causes, reused identities and live attached processes still need cleanup
proof.

`--suite rich-acp-warm-continuity` adds six explicit cells: all three providers on
local and Daytona. Three browser-driven turns must preserve native session,
provider session, runner instance, PID/start identity and project workspace.
Daytona also requires one continuously running sandbox and created/resumed/resumed
lease history. Each turn has a 120-second limit; each three-run cell has a
420-second budget and must be reserved accordingly. Existing Codex warm cells
remain separate. All these suites are excluded from `--all`, never automatically
retry, and remain pending qualification until their paid evidence passes.

Denial ordering uses canonical request, decline-resolution, delivery, failed-edit
and terminal source sequences. Sample checkpoints retain the exact run/turn/source
cursor. File samples and continuous-watch coverage compare only observer-local
times. Provider emission, browser click and database transaction clocks are never
compared to each other. Final remote samples use the sealed, independently verified
process-retirement receipt; their timestamps are not relabeled as host time.
This denial case does not qualify Stop during a definitely pending native request.
That active-turn cancellation boundary needs a separate live case. The attached
async-command oracle is unchanged by this denial-only correction.

Copilot denial settlement v3 (suite definition v5) requires a retained pre-Stop API
observation. The fixture awaits that artifact write before dispatching Stop and
matches exact source identities and row hashes against final evidence. It waits
at most 2s for natural settlement within the existing deadline. Normal completion
first observed afterward cannot pass. A row's createdAt is transaction-start time,
not proof of commit order. Older failed artifacts lack this observation and cannot
establish a completed-before-Stop causal boundary; they remain failed.

The Copilot denial Stop cell requires the controller run to remain `running`
until its Stop request. A provider `turn.completed` can satisfy its completed
branch while that controller run remains active. An already `succeeded` or
`cancelled` controller run cannot satisfy this Stop-specific cell. Such a result
is not evidence that the provider bypassed denial; natural completion without
an active controller Stop needs separate coverage.

Suite version 5 binds a fresh `cancellationRequestId` UUID in the retained
pre-Stop observation to the public cancel request and its exact durable native
intent. It rejects prior startup/Stop markers before dispatch and a competing
request that wins after the last read. The server atomically reserves the caller
identity; the fixture does not infer ownership from timestamps or HTTP success.

## Stop during an unanswered native permission (explicit only)

`--suite native-active-stop --task pending-permission-stop` selects Cursor and
Copilot on local or Daytona, one run per cell. These four cells are excluded
from `--all`. They use `approve-reads`, per-turn lifecycle and Cursor Agent mode;
provider timeout is 120s and the attempt budget is 300s. The fixture asks for one
exact native write, observes its unanswered permission card, then sends the
public Stop request with a freshly retained caller UUID. It never denies or
approves that callback before Stop.

Suite version 3 accepts a permission card before or after its correlated tool
start. Both the exact native origin and canonical start must already exist with
the unanswered permission when the fixture retains and rechecks the pre-Stop
API snapshot. The v2 pending receipt binds all four rows by hash and source
sequence through settlement. Missing, changed or replayed evidence cannot be
filled in after Stop. This is a new grader definition; old v1 pending receipts
and failed paid attempts are not regraded. No original provider wire order is
inferred from API insertion or display order.
Native notice ordering follows each real projector: Cursor waits for its exact
command origin before emitting permission evidence; Copilot can emit the
permission notice first. Both still require the exact tool origin before Stop.

Suite version 4 uses the normalized Product cancellation contract and writes
`paperclip.e2e.native-active-stop-settlement.v2`. It requires the exact request,
item and turn closure with `reason: turn_terminal`, followed by the same stream's
`turn.cancelled` with `status: cancelled` and `error: null`. The Product harness
emits these fields; raw backend-only cancellation metadata is not its contract.
The retained pending v2 receipt, caller UUID and durable scoped acknowledgement
remain mandatory. This fixes an oracle mismatch observed after a real Stop was
acknowledged; the failed attempt remains failed and needs a fresh live run.

Passage requires a canonical cancelled request and cancelled provider turn,
exact caller-intent acknowledgement, an unfinished task, rejection of a later
stale answer, no follow-up run, continuous target no-effect observation and
owned process retirement. Normal completion and interrupted/failed turns do
not qualify this case. Native permission cards use runtime requests; ordinary
issue-interaction rows are not substituted for their authority. Pending and final
screenshots, `native-active-stop-pending.json`, `native-active-stop-settlement.json`
and cleanup evidence retain the boundaries. Daytona also requires the exact
owned lease and sealed remote observer proof before sandbox deletion. Suite
version 2 introduced remote filesystem coverage only through verified retirement
of the owned runner/provider tree, with no target or workspace mutations; it
does not call a later read of the seal a fresh observation. Local cases retain
four filesystem phases through cleanup. Remote UI/stale-answer checks and final
API checks are separate from this lifetime-bound filesystem proof.

This suite adds an active-work cancellation oracle; it does not reinterpret
older denial or cancellation results. Current live qualification is pending.
Provider death during a pending callback remains a separate uncovered case:
the existing chat worker-crash hook targets a runner worker and cannot establish
safe ownership of the native provider process in both environments.

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

The explicit-only `confirmation-replies` suite also includes `unanswered-question-return` for native Claude and Codex (three provider turns). The browser asks a saved color question, dismisses and reopens the fresh form, sends an unrelated message, verifies the reply while the original stays pending, reloads, reopens the history entry, submits Blue, and verifies the saved answer plus a later agent acknowledgement. After dismissing the fresh form and before and after reload, the history card is the only pending-question reminder; the composer has no duplicate pending-input badge. It checks that no tasks were created. Unique, UI-ready screenshots show each checkpoint; individual checks are included in the report. This is a bounded mechanical workflow check, not broader semantic answer-quality qualification.
## Direct blocker guidance

`blocker-guidance` is an explicit-only Product E2E suite for the production
coordination skill: three local cases on legacy Codex and legacy Claude (six
cells). Native runners omit this operational skill and are deliberately outside
this suite. This is behavior coverage for PR #14188, not a native recovery or
connection-authorization qualification.

| Case | User outcome |
| --- | --- |
| `human-authority` | A tenant administrator action waits for human direction without assigning work to a manager who lacks access. |
| `hiring-permission` | A worker without hiring permission asks for authorized direction; no agent or hire approval is created. |
| `requester-scope` | A confidentiality conflict produces a human-input question the requesting user can answer while the worker retains the task. |

Each cell creates an ordinary worker and a manager with assignment permission
but no hiring permission or external administrator capability. Both receive the
normal bundled coordination skill through the production skill-sync API. The
browser creates the task. The prompts describe business facts and never name
interaction APIs, expected task statuses, or grading rules. The hiring case
measures behavior with a persisted missing permission; it does not require the
model to attempt an HTTP request that it already knows will be denied.
The company policy requires the requester's decision before drafting a public
note that was requested with individual salaries. This requirement is limited
to salary-disclosure requests; it does not require reconfirmation of unrelated
scope changes. Without that business constraint, a salary-free substitute draft
is a plausible alternative and does not exercise the intended requester-routing path.

The independent grader requires one saved human-only question set or confirmation and `in_review`,
preserved ownership including activity history, no extra tasks or manager runs,
and no hire. After reload, the browser supplies a scenario-specific decision:
defer the SSO rollout, defer the hire, or write the public note without salaries.
Each answer includes a unique reference that must appear in the worker's reply.
The same worker must consume the saved answer, acknowledge it, and finish the
same task. Question sets may contain multiple questions. For a confirmation,
the browser declines the proposed action with the new scope saved atomically in
its reason field. Native closed-choice questions without a custom answer and
confirmations without a reason field cannot carry the requested free-form scope;
the helper reports that limitation before clicking, without timing out or waking
the worker with incomplete instructions. Legacy question cards retain their
production form's implicit Other answer. The grader requires
human resolution of the original card and the saved user direction. It never
approves an administrator or hiring action to get a passing result.
The requester-scope answer supplies an approved salary-free welcome note and asks
for its exact publication as a task comment. The grader requires a new worker
comment whose entire body matches that note; an acknowledgement or a note with
added salary details fails. This bounded artifact check avoids guessing note
quality from a keyword. Missing evidence fails. Calibration covers plausible
wrong outcomes.
Agent-requester scope routing, legitimate capability-based delegation, real
connection setup, and issue-dependency resolution remain outside these cells.

```sh
pnpm test:e2e:runner -- --list --suite blocker-guidance
pnpm test:e2e:runner -- --id blocker-guidance.legacy-codex.local.human-authority
pnpm test:e2e:runner -- --suite blocker-guidance --max-parallel 2
```

Each cell expects two provider turns, permits at most four recorded runs, and
has an eight-minute deadline. Normal company-wide cancellation and isolated
instance cleanup apply even if a manager unexpectedly runs. All recorded runs
contribute to the existing billing contract. Evidence includes the waiting and
final task screenshots, saved checkpoints, final observations, source revision,
profile/model, catalog digest, and SHA-256 fingerprints of both changed skill
files and the grader/flow in `snapshots/blocker-guidance.json`. Grader version
`paperclip.blocker-guidance.v6` requires the approved public note, a saved answer
before the confirmation wake, and a new worker reply after the waiting checkpoint,
accepts writable confirmations and multiple questions, and records `inputUx` separately from
the blocking checks. Direct text input is the preferred UX for these open-ended
requests; a valid confirmation can satisfy the waiting contract while losing
that UX dimension. Version 6 permits an omitted user addressee and verifies that
the actual requester resolved the scope question; it rejects a conflicting
explicit recipient or a different resolver. Earlier results retain their original grades. Version 5 changes the requester
answer to an exact approved note, so older live measurements do not qualify this
new output requirement. Version 2
diagnostics exposed local Claude skill shadowing and a redundant browser reply
after confirmation rejection; do not treat those as clean PR measurements.
The earlier generic goal-replacement/echo answer is a separate diagnostic probe:
Claude refused it as prompt injection even with a saved human resolver. Its
failed grades remain retained; the ordinary workflow uses the business decisions
above. Compare only matching answer definitions, source hashes, and grader versions.
Use distinct campaign IDs for independent repetitions; do not overwrite an
earlier campaign or treat repeated samples as infrastructure retries. Use the normal
Product E2E report generator; retained failed attempts are part of the result.
Before dispatch, the fixture verifies that both served company skill files match
the evaluated checkout byte for byte. The skill snapshot and provider run evidence
are retained privately alongside the grading checkpoints for failure diagnosis.
Claude receives a fresh provider home and config directory inside the disposable
workspace so a user's installed skill cannot shadow the managed skill under test.

### Published-install Pi lane

The 26 explicit Pi cells can run against an independently installed public CLI
and server instead of the source CLI. Supply all four reviewed pins:
`PAPERCLIP_RUNNER_E2E_INSTALLED_CLI` (canonical `paperclipai/dist/index.js`),
`PAPERCLIP_RUNNER_E2E_INSTALLED_CLI_SHA256` (bare SHA-256),
`PAPERCLIP_RUNNER_E2E_INSTALLED_SERVER_ROOT` (canonical resolved public server
package root), and `PAPERCLIP_RUNNER_E2E_INSTALLED_SERVER_SHA256` (its
`dist/index.js` SHA-256). The CLI must resolve that exact server dependency, with
matching public package versions. Build/install provenance and the complete
installed dependency/assets inventory remain separate required evidence; the
entrypoint checks alone do not prove that closure.

Run the explicit `paperclipai runtime setup pi` for that installation first.
This lane rejects candidate flags, local/remote daemon overrides, provider asset
or pack overrides, and Node injection. It launches the installed JavaScript CLI
without a TypeScript loader, rechecks its pins on controller restart, and records
`installed-cli-admission.json` in private attempt evidence. It supports only the
explicit Pi extended, native, controls and warm suites, which require none of the
source-only response barriers. Cursor/Copilot qualification gates stay intact.
Pi's historical `qualificationCandidate` fixture selector remains a roster key;
it no longer grants an opt-in when the source Pi declaration admits normal use.

Installed Pi Daytona cells also require the published plugin fixture inputs
`PAPERCLIP_RUNNER_E2E_INSTALLED_DAYTONA_PLUGIN` (canonical package root),
`PAPERCLIP_RUNNER_E2E_INSTALLED_DAYTONA_PLUGIN_AUTHORITY` (canonical JSON file),
and `PAPERCLIP_RUNNER_E2E_INSTALLED_DAYTONA_PLUGIN_AUTHORITY_SHA256`.
The authority schema `paperclip.e2e.installed-daytona-plugin/v1` pins a canonical
`graphRoot` and four public packages (`plugin`, `sdk`, `shared`, `daytona`).
Each has `root`, `packageSha256`, `entry`, and `entrySha256`; `plugin` also has
`manifestSha256` and `workerSha256`. Roots must be the named packages beneath
that graph's `node_modules`. The fixture verifies compiled public exports,
exact dependency versions, resolved package identities, and file pins before
launch and again immediately before the ordinary `/api/plugins/install` request.
It records `installed-daytona-plugin-admission.json` privately. Missing pins in
installed Daytona mode fail; they never select the source plugin as a fallback.
Local cells need no Daytona plugin. Source-development lanes retain their
existing fixture path. These entrypoint checks do not replace the separately
required tar provenance and complete installed dependency inventory audit.
The fixture inputs do not reach the production server environment.

Before a paid installed local cell, use the same launcher and WebServer chain
without provider work:

```sh
node --import ./cli/node_modules/tsx/dist/loader.mjs \
  tests/runner-e2e/launch.ts --installed-startup-only \
  --id extended-harnesses.runner-acpx-pi.local.hello-complete \
  --max-automatic-retries 0
```

This mode requires the reviewed installed CLI pins, rejects provider credential
inputs, skips local credential-file loading, and runs only health, browser UI,
and zero-company checks. It retains separate private startup evidence and cannot
produce a passing provider case. Existing process, IPC, and scratch cleanup stay
in force. The installed lane invokes Playwright's public JavaScript bin directly
with the current Node; pnpm's generated bin shim would inject `NODE_PATH` into
the WebServer. Arbitrary ambient `NODE_OPTIONS` and `NODE_PATH` remain rejected.


## Production hiring templates

`hiring-templates` adds two explicit-only local cells:

- `hiring-templates.runner-codex.local.hire-coder-template-reuse`
- `hiring-templates.runner-acpx-claude.local.hire-coder-template-reuse`

The fixture creates a CEO through the public API without an instructions bundle
override, using production permission defaults and a personal managed AI
connection. Chromium sends the same user request on candidate and baseline:
use `paperclip-create-agent`, read its skill, drafting guide, review checklist
and coder example, fill its name/company/manager/issue-prefix placeholders,
hire one permanent coder with that example, and delegate a
saved JSON label-normalization fixture. Reading the optional references is an
explicit fixture user request. It is not an additional production requirement.
A follow-up delegates a second fixture to the same coder with underscore
separators while preserving the original. A final read-only chat turn requests
recorded task status. Three CEO turns and two actual worker executions make
**five required work turns per cell**, plus at most **two strictly attributed
automatic task-completion turns** (seven total maximum), with a **15-minute
deadline** and 1,000-cent
company/CEO budget hard stops. Normal managed-account fixture cleanup and
company-wide cancellation apply. Both cells opt into the existing native API
tools. No model-authored code is executed by the grading host.

The independent oracle checks every JSON input and computed value, authorship,
two distinct completed tasks, project/reporting identity, exactly three user-requested
CEO turns and one coder execution per task,
managed execution-account attribution, original document preservation, and
worker reuse. Bounded completion turns must have the same company, managed
account, responsible user, chat generation and known completed tasks; unique
server delivery/update receipts; valid completion timing; and a run-attributed
chat reply. One completion turn may batch both tasks. Unknown, duplicate,
failed, retried or extra work runs, and notification-created tasks fail. Every
actual run remains in usage/cost accounting. The hiring scorer and final chat
count guard use the same rule. All other chat count guards stay unchanged.

The versioned `paperclip.hiring-templates.v3` oracle separately checks the production CEO bundle, assigned hiring
skill, source hashes, completed pre-hire read receipts, the saved source-derived
coder example, and durable instruction/skill selections.

`loadDefaultAgentInstructionsBundle("ceo")` determines the expected files and
bytes on each evaluated revision. A historical four-file CEO bundle and long
coder example are admissible; the candidate is not imposed on the baseline.
Instruction bytes and word counts are measurements, without a size pass/fail
threshold. The definition digest fingerprints the cases, flow, grader, shared
turn-accounting helper and final chat guard;
source evidence also fingerprints the loader, generic execution contract,
selected CEO files and production hiring references. Use the same fixture
revision, scenario nonce, profile/model, managed account method and local
environment when comparing candidate and baseline, and record each evaluated
source SHA. Porting the fixture to a baseline is harness preparation, not a
baseline runtime qualification.

`hiring-template-source.json`, `hiring-template-initial.json`, and
`hiring-template.json` retain source/bundle bytes, hashes, saved child documents,
assigned skills, completed public run events, read receipts, budgets and grades
inside the access-controlled evidence package. The final grade separates
`outcomePassed` from `comparisonStatus` (`comparable` or `uncomparable`), with
`outcome` and `coverage` matcher paths in the normal report. Missing, wrong,
failed, post-hire or unidentifiable reads make source coverage uncomparable even
when task outcomes pass. The existing machine failure classifier remains
unchanged: a coverage-only failed attempt must be counted as an uncomparable
pair, not presented as a workflow behavior regression or template equivalence.
The new marked screenshot shows only the synthetic chat/task state; private
snapshots follow the existing publication boundary.

Read receipt support deliberately recognizes direct `cat`, positive-count
`head`/`tail`, and printing-only `sed -n` argument forms. Help, version, zero-count,
editing and unknown arguments do not count. It also recognizes
canonical file-read events with a preserved relative skill path and completed
output. ACPX redacts absolute file locations from canonical events; a read whose
path no longer survives is unprovable and remains uncomparable. Echoing or
listing a filename and successful task output do not prove a source read. No
adapter event changes are part of this suite. Unit calibration and discovery do
not qualify either live provider cell.

```sh
pnpm test:e2e:runner -- --list --suite hiring-templates
# Only after separate approval for the bounded live run:
pnpm test:e2e:runner -- --id hiring-templates.runner-codex.local.hire-coder-template-reuse --max-automatic-retries 0
pnpm test:e2e:runner -- --id hiring-templates.runner-acpx-claude.local.hire-coder-template-reuse --max-automatic-retries 0
```

The existing `first-task` suite uses the actual onboarding wizard and captures
the changed chief-of-staff persona and skill selections; it needs no fixture
change for that default selection. Hiring from that wizard-created chief of
staff remains a separate follow-up qualification.

### Hiring completion accounting evidence

The v3 hiring grader uses turn-accounting v2 in both executable guards. It requires complete per-run public event streams, exact native tool-use/result pairing and canonical execution IDs for completion actions. Only successful known GET issue/document/comment operations, verified reads/discovery, and attributed native chat finish are admitted. Writes, failed mutation attempts, incomplete streams and unknown actions cannot pass. Separate ACPX host request IDs and provider execution IDs are not joined by name/order/count; missing mapping is uncomparable action coverage, not a measured task failure. The original source-read and exact template checks remain unchanged.

The live fixture retries entire bracketed observations, waits for both known task callbacks and attributed replies (including batching), checks untruncated pending-wake diagnostics, and requires two equal settled observations. Silence before outbox enqueue is not delivery. Five-turn generic accounting remains calibrated for no owed notifications; this delegated fixture owes two completions. All actual runs remain counted for usage and cost. Retained original, limited sidecar-v1, initial executable, and stricter v3 assessments remain separately versioned; no models are rerun by the repair.

Recovery-state retention uses raw cleanup results before evidence publication. An owner-only resource-admission marker for Daytona cells also preserves state if the test worker dies before producing a result. Local worker crashes do not imply remote allocation; their process cleanup proof still applies independently. Confirmed bootstrap failures before allocation remove their temporary state and retain their original failure classification.

## Public installed release smoke

The shared task-creation helper uses the current prompt-only composer and binds
each task to its actual HTTP creation response ID, since its generated title may
change during execution. The provider-free `tests/e2e/runner-task-creation.spec.ts`
regression verifies assignee, project, and all three work modes with paused agents.
Explicit title-preservation and strict native permission cases use Search’s
“Create task from this query” action to expose the normal title field, and verify
that the creation response preserves it with `titleNeedsGeneration: false`.
This keeps automatic title naming from introducing an unrelated permission
request before the tested native write. Permission policy, provider prompts,
command correlation, and no-effect assertions remain unchanged.

Set `PAPERCLIP_RUNNER_E2E_INSTALLED_CLI` to the absolute public consumer's
`paperclipai/dist/index.js` for an installed-product acceptance run. Install the
public package graph and run its ordinary `runtime setup cursor` first. The
supervisor launches that compiled CLI from its own package directory; repository
server-entry patches, provider-bin shims, loader injection, provider packs and
native binary overrides are removed from the server environment. Qualification
admission is rejected, so this path requires production admission. Use the
existing browser/API cases and encrypted company-secret fixture path.

Install the public `@paperclipai/plugin-daytona` package separately for a Daytona
smoke. Set `PAPERCLIP_RUNNER_E2E_INSTALLED_DAYTONA_PLUGIN` to its absolute installed
package directory when it has its own dependency root. The fixture checks its
compiled entries and release version before provisioning. The version must match
the installed CLI by default. If the release uses independent plugin versions,
set `PAPERCLIP_RUNNER_E2E_INSTALLED_DAYTONA_PLUGIN_VERSION` to the exact plugin
version in the release record. Record the plugin tarball SHA-256 with that version;
do not substitute a workspace build or an older installed plugin.

For a diagnosed failure campaign, `PAPERCLIP_RUNNER_E2E_KEEP_FAILED_PRIVATE=1`
retains the attempt's owner-only private directory after a failed case even
when owned cleanup passed. This does not alter the case or cleanup outcome.
Private traces and database files must not be published. Unconfirmed cleanup
always preserves recovery state regardless of this optional diagnostic flag.

The `file-edit-validate` fixture independently downloads the exact active artifact work product from the tested run. It requires the matching run-attributed attachment, filename, MIME type, recorded byte count and SHA-256, then compares the downloaded content to the expected bytes. A workspace file alone cannot satisfy this gate. Explicit failed-case diagnostic retention follows the final result after integrity, isolation and evidence checks, including incomplete publication.
