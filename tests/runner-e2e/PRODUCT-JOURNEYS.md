# Product journeys across deployments

`product-journeys` is an explicit Product E2E selection. Deployment is separate
from the `local` / `daytona` execution environment. Existing selectors, execution
IDs, and the `--all` matrix keep their historical meaning. These are scripted
browser journeys with API setup and independent assertions; they are not strict
browser-only “use as a user” discovery.

| Concept | Owner |
| --- | --- |
| Journey | User actions, prerequisites, assertions, feature-map associations |
| Target provider | Authentication, deployed identity, configuration, acquisition, cleanup |
| Setup recipe | Resolve requested company/user/task capabilities through the fixture registry |
| Campaign | Explicit journey order, target, model profile, limits, lifetime |

Shared code is in `product-journeys/`. Cloud fleet operations, email-code login,
private state, and trusted CI live in the private `paperclip-cloud` repository.
The `TargetProvider` version-1 interface is defined in `product-journeys/types.ts`.
Journeys receive a ready browser, company-scoped API, IDs, and capabilities. They
never start a server or depend on a tenant filesystem.

## Selections

| Journey | Required starting state | Observed outcome |
| --- | --- | --- |
| `task-create` | Company and signed-in board user | Create a task through the shared production composer, assign it to yourself, reopen and reload it, verify the saved prompt and no agent work |
| `project-task-context` | Company, signed-in board user, task-write capability; no model runs | Create a project and a self-assigned task with the project selected through the production dialogs. Reopen the project, open its task, reload both, and verify exact saved company, project, prompt, assignment, standard work mode and zero runs |
| `ask-question` | Company, configured agent capability, positive model allowance and exactly one permitted work run | Reuse the existing cross-model Ask question prompt; require one successful run with matching company/task/agent/model/environment, one saved exact answer, and visible readback after reload |
| `question-answer-resume` | Native agent; up to three work runs | Reuse the classic two-question story: answer a choice and a free-text question through the browser, verify each native continuation, then read the exact saved answers in an agent-authored task document after reload |
| `task-properties` | Company, signed-in board user, task-write capability, prepared run-owned backlog task | Open its properties, assign it to the signed-in user, reload, check both UI and saved assignment; verify no agent run |
| `task-document-persistence` | Company, signed-in board user, task-write capability, prepared run-owned backlog task; no model allowance or runs | Create a general document through Artifacts, edit its title and body, reopen and reload it; independently verify exact canonical content, preserved original and latest revisions, board-user authorship, and no agent work |
| `task-search-filter` | Company, signed-in board user, task-write capability; zero model runs | Search three owned target/control tasks through the task list, require exact matching identities, filter Backlog to exclude the completed control, reload and return from the exact saved task with search/filter context intact |
| `plan-revise-accept` | Native agent; three work runs | Reuse the classic Plan story: canonical draft, browser revision request, new revision-bound confirmation, approval and exact saved final response |
| `build-revise` | Native agent; two work runs; qualified Docker artifact oracle | Browser-download both ZIP versions, independently exercise source/CLI behavior, verify different hashes and preserve the original download |
| `protected-actions` | Native agent; four work runs; authenticated reachable review-service fixture | Approve one action and decline another on separate owned tasks; verify zero calls before either decision, one after approval, zero after decline and a truthful saved explanation |
| `create-skill-studio` | Native agent with skill-write permission; one work run | Create a uniquely named company skill, open its activity card, edit in Studio, reload and verify task-card readback |
| `stop-redirect` | Native agent; three work runs; qualified Docker oracle | Download a verified checkpoint, observe an active native command with current-turn usage, Stop it, verify cancellation and settled accounting, then send one new direction and complete without original-run activity |
| `followup-while-running` | Native agent; a maximum of two work runs | Save a follow-up while an independently observed native shell command is still active, then require one attributed final reply with the late requirement after reload; in-turn steering and one normal successor are accepted |
| `hire-delegate-reuse` | Native lead with a fresh user chat and scoped hiring permission; Agent Chat enabled; direct hiring policy; seven work runs | Hire one teammate, delegate a saved checklist, reuse the same teammate for a saved review, verify native run and revision authorship, preserve the original, and follow the lead's saved result link after reload |
| `cloud-onboarding` | Signed-in admitted Cloud account; fresh workspace; qualified bounded provider route | Create workspace in the portal, connect API key and native Codex agent in the wizard, complete a task, download and independently check its artifact |

The deployment-targeted Stop journey asks the revision to finish one harmless
`printf` readiness command, then run `sleep 90` once in a separate shell call
before changing files. The readiness call lets a provider report its first
current-turn usage before the long hold starts. Running the hold first can leave
no complete usage until that command has already ended. Startup alone cannot trigger Stop. An independent observer
requires both a still-running bound native command and a complete, nonzero usage
report for its current turn. After Stop, native cancellation and exact lease
cleanup remain required. Before the redirect, the original run must have a
complete accounting receipt, no pending accounting and a saved accounting
timestamp. Receipt sources and sequences remain recorded, but controller changes
and clock order cannot substitute for the run's actual settlement state. A receipt
that was already ready before Stop is accepted only when the exact cancelled run
is actually accounted and no longer pending. Canonical usage receipts, including
raw, partial and complete forms, do not count as continued work when their API row
and envelope match the observed run, company and agent, with consistent source
event IDs, sequence numbers and instance IDs. An accounting source can change
after Stop; its receipt does not need the pre-Stop Runner instance or accounting
source and sequence. Pre-Stop work still requires the current Runner and turn.
Missing context or mismatched source event IDs, sequence numbers, instances or
envelope versions keep the usage row in the strict work evidence. Tools, messages
and other item events still count, including work that arrives between
cancellation and accounting settlement.
These waits share the original journey deadline.
The three-run limit, budget and original download checks remain unchanged.
Missing or partial accounting never counts as free work. Local evidence controls
do not establish a deployed pass.

The question-resumption journey uses the same natural-language scenario, browser
answer helper and behavioral grader as the classic `question-resume` suite. Native
reference cards may expose a text field or an explicit canonical written-answer
control on one single-select question. The browser must type the complete reference
and submit no predefined option. An absent or disabled custom-answer capability is
not an equivalent form. The user still answers exactly two distinct native questions;
the document must retain the actual choice and typed reference after reload.
Provider questions can stay in one run; durable native questions create one exactly bound
continuation each. Creation must have an applied semantic receipt or a completed native
API mutation receipt with the original card, exact scope, form and idempotency key.
An API receipt must retain its creation identity unchanged after the answer. A form or
run count alone is never provenance. A target declares a three-run maximum and positive model allowance,
and a passing receipt must contain one to three attributed native runs. Other journeys
retain their exact run-count requirements. Both real board answers, no premature
output, the sole document's agent/company/task ownership and its reloaded revision
are independently checked. The private provider owns authentication, setup, accounting
and cleanup. Local calibration is not deployed-target qualification.

The shared Studio helper waits for the original saved file body before typing.
An editor control can mount before the file query completes; editing that empty
draft can otherwise lose the original content when the file arrives.

The hiring journey uses the existing Agent Chat prompts and native hiring oracle.
It gives each disposable project, agent, and task a campaign name. The first
turn only hires. The target provider can then verify the native creation audit
and prepare that exact teammate's budget before the next turn delegates work.
Both handoffs ask for the task to be created already assigned to that teammate.
They use the normal composer agent and project mention formats, with the exact
IDs from the independently verified hire and owned project. Missing, foreign or
mismatched context fails before constructing the handoff. The mentions provide
the intended resources without prescribing a tool call or bypassing normal delegation.
The handoff selects these references through the normal rich-editor mention menu
and verifies each chip target before sending once. Typing Markdown link syntax
as plain rich-editor text escapes it and is not a mention. The saved user body
must still match the requested body exactly.
Creating work for the lead and later reassigning it starts additional native work
and fails the existing assignee and run checks.
When the lead uses a delegated personal connection, normal hiring selects the
responsible user's default rather than copying the manager's identity. Before
registering any chat or child-creation intent or sending the first turn, the
journey reads the actual signed-in workflow user's provider default and requires
the exact approved connection and grant, connected and owned by that user.
After hiring it independently checks the exact child installation. The underlying
connection's creator is not the owner of the user's default selection. Missing,
different or ambiguous authority fails closed; no credential, default or grant is
changed. A responsible-user hire stores the canonical `api_key` placeholder even
when the approved default uses a subscription. The resolved native method must
still match that independently approved default. Every successful native run must also retain the approved connection,
grant and responsible-user attribution in its canonical execution metadata.
Those references are compared privately and omitted from observation evidence.
The first independently approved child binding becomes an immutable expected
snapshot for the final shared hiring oracle; later binding changes fail. Only
typed transient observation GET failures may poll again within the original
deadline. Approval, authentication and ownership failures are never replayed.
The checklist and review each require one successful child run and a current
document revision authored by that run. The lead uses three requested turns and
two separate server completion callbacks,
for seven work runs in total. Each callback must identify exactly one of the two
completed child tasks with a distinct server delivery receipt; arbitrary extra
lead turns fail. The journey waits for each callback and its exact run-authored
saved reply before the next user turn. A terminal run can precede its final
comment; missing materialization polls within the existing deadline, while a
wrong author or binding fails immediately.
The lead has a maximum of five work runs and the teammate has two.
A 500-cent case allowance is split into 300 cents for the lead and 200 for the
teammate; the allocation must not duplicate the declared case allowance.
Setup probes and unpriced usage remain separate accounting
uncertainties. The journey does not change company hiring policy or instance
features. The provider must own and clean up the hired agent, both child tasks,
the chat, and the project. Before the first send, a fresh-chat intent records the
company, user and owned lead after a normal GET confirms no existing chat.
Recovery can attach only that exact fresh conversation. Saved replies and links
are allowed to render after reload within the journey deadline. Cleanup includes
unexpected campaign-owned children after
failure. A new deployment must qualify the journey before scheduled admission.
Child discovery reads the exact native creation audit after the run snapshot,
then fetches each audited agent/task ID directly. It never depends on the first
page of a shared company list. Each proven child is recorded before the next
lookup can fail. Observation retries are limited to typed transient GET transport failures within
the existing deadline. Ownership callbacks and grading failures are never
retried. Audited same-company children are recorded before manager/project
checks fail; foreign or malformed rows remain unowned and fail the journey.

The task-document journey uses the normal default-chat Artifacts pane and the
shared document editor. Classic mode retains its editor in the task body. The
general editor excludes Plans, which retain their conversation and approval
flow. Setup creates only an owned backlog task, never the document or its
revisions. The oracle accepts additional autosave revisions, but requires both
measured versions to remain exact and independently readable. Shared coverage
does not establish a live pass or admit the journey to a target's daily plan.
The reopen step selects Backlog explicitly and searches the owned title. A
user's saved task view cannot route that check to Done or a personal inbox.

The project/task journey records durable project and task ownership before each
creation and immediately saves the response IDs. Its project must retain its
planned state. Independent project-filtered task reads must contain the exact
new task. The final task view must show the same project after reload. Browser
readback uses the main project heading and visible task content rather
than a duplicate sidebar label. It binds navigation to the saved project URL key
and task identifier. Closed failure codes identify project-list, project-open,
task-open and property-readback failures without retaining Playwright page text. A Cloud
provider must clean only these owned resources, settle owned tasks before
archiving the project, and preserve their history. Catalog registration does not
admit this candidate to a saved daily plan; a real deployment pass is required.

The search/filter journey creates only campaign-owned, board-assigned tasks through
the public API. The target and completed control share a unique search marker;
a second Backlog control has a different marker. Search and status selection use
the production controls. The oracle compares the complete visible task identity
set at each step, verifies the exact saved company, owner, title, description and
status, and checks all three tasks have no native runs. It reopens the target after
reload and browser Back, and leaves the target visible for the harness screenshot.
The combined Tasks shell reapplies its named view's status preset on mount, so
the journey first proves the checkbox filter, then selects the normal Backlog
view and enters the same search again before checking reload/Back persistence.
Coordinator and legacy task lists keep their supported saved-filter behavior.
The status selector stays inside the Status group. Legacy status glyphs contribute
their label to the checkbox's accessible name, producing `BacklogBacklog`; the
refreshed panel supplies the explicit `Backlog` name. A credential-free browser
regression covers both forms and a separate assignee called Backlog.
Unexpected browser/API errors retain only a closed `task_search_<stage>_failed`
code. Stage names come from the journey source; raw exception text, URLs, form
values, and response bodies are not added to reporting. Existing owned evidence
failures keep their specific codes and the screenshot privacy guard stays in place.
It does not depend on row order or an otherwise empty company. The browser reads
the visible links together. Per-row indexed locators can disappear
while a search replaces the old collection; a detached snapshot is retried within
the existing poll deadline. Duplicates, unknown destinations, and extra controls
remain evidence failures. This does not add a journey retry or extend its timeout.
The selection stays manual until a separate target owner records a fresh pass and admits it to a daily
plan; adding the shared journey does not qualify any deployed target.

Supported acquisitions are managed self-hosted (`local`), registered existing
Cloud (`local` or `daytona` when present), and new Cloud. New Cloud must start
with onboarding. Its context can then satisfy the identical task-properties
journey without another setup. A recipe reports `startingState: recipe`;
reusing successful onboarding reports `onboarding`. Preconfigured state is never
counted as onboarding coverage.

The scripted onboarding request supplies a self-contained child brief. The
parent must first save its proposal through the existing native confirmation
tool and check the saved card receipt. The browser records the human decision;
the parent must not record its own approval or treat the opening scope as acceptance.
It must copy the full marked brief verbatim into `create_task.description`,
including tool names, parameters, and the encoded input. It orders the child's
work: create the files, publish `connection-proof.json` with that exact filename
and workspace-relative content reference, save its Paperclip task document with
the returned file link, then report completion. A Markdown workspace note does
not replace the task document. It explains the native completion contract:
include actual verification, omit the optional schema, and use receipt-derived
deliverable references in evidence and file artifacts. Local input paths are verification
details. Correcting rejected tool arguments stays within the same attempt;
it does not retry the journey. The model still computes the result, publishes
the file, saves the document, and completes the tasks. Independent download,
math, provenance, document, and parent-link checks remain authoritative.
Historical failed attempts retain their original fixture and outcome.
The parent's final reply must use Markdown links to the saved child results,
including the attachment's real content or download path. Naming a file or
document key in inline code does not satisfy the existing parent-link check.

Save this credential-free local target config outside the repository:

```json
{
  "version": 1,
  "id": "local-qa",
  "mode": "managed-self-hosted",
  "journeys": ["task-properties"],
  "executionEnvironment": "local",
  "baseline": { "features": {}, "connections": [] },
  "limits": { "durationMs": 600000, "modelBudgetCents": 0, "maxRuns": 0 }
}
```

```sh
pnpm test:e2e:runner -- --suite product-journeys --list
pnpm test:e2e:runner -- --target-config /private/target.json --preview
pnpm test:e2e:runner -- --target-config /private/target.json --output /private/new-campaign
```

Preview resolves selections and declared changes without loading the private
provider, reading credentials, signing in, provisioning, or making model calls.
Its output includes required state, features/connections, lifetime, and limits.
Output directories must be new; an attempt is never overwritten. Browser-only
results use null provider/model and runtime `none`, including failures before
the journey starts. No artificial model run is introduced for reporting.
New execution IDs have the form
`product-journeys.<target>.<profile-or-browser>.<environment>.<journey>`; the
report reader continues to accept historical four-part execution IDs.

Cloud config supplies `adapterModule` and the private provider's reference-only
`adapterConfig`. Use the private CLI and runbook to configure those fields.
Paid onboarding requires positive `modelBudgetCents` and `maxRuns`, a duration
of at most one hour, and a qualified operations adapter. The initial private
Cloud adapter admits at most 30 minutes and $10. Select `runner-codex-mini`
explicitly for its `gpt-5.4-mini` pilot; existing profile defaults remain unchanged. There are no automatic
story retries. One campaign may create at most one disposable workspace.

Workspace contention can defer a child before provider execution. The journey
keeps that run and follows only its unique, scoped durable replacement when the
server proves that no provider work started. A scheduled replacement remains
pending and consumes the run limit. It cannot satisfy completion; the child must
still finish through native execution and pass the independent artifact checks.

A failed native run can remain pending when the authenticated run projection
identifies agent-owned automatic recovery on that same run. Its native phase
must remain retryable, with matching nonempty cause strings, a bounded attempt
and retry schedule, and no successor. Cause strings are diagnostic values, not
a positive retry policy. Known permanent, permission-declined, and exhausted
causes are also rejected defensively. The wait stays within the original
campaign deadline. An overdue retry can still be reconnecting; it does not extend
the deadline or authorize a new story attempt. Ordinary failures, terminal or
board-owned recovery, and exhausted attempts still fail. The producing turn must
settle before proposal acceptance, and the recovered child must actually succeed
before the existing document, artifact, download, and parent-link checks can pass.

An approved child that commits a board-owned current-track blocker fails with
`onboarding_child_task_blocked` once all owned work has settled. The latest child
run must prove the blocked decision at the child's current status version.
Parent dependency waits, pending recovery, and stale child decisions keep waiting
within the original deadline. This failure does not satisfy any delivery check.
The [semantic control-plane port](../../server/src/services/native-runtime/paperclip-control-plane-port.ts)
writes `prpReportedWorkDisposition`. [Native finalization](../../server/src/services/native-runtime/native-run-finalizer.ts)
commits the blocked decision and `statusVersionAfter` into the run's `resultJson`.

The attached `ask-question` recipe requires a prepared native general agent and
an explicit execution environment. Legacy execution is unsupported until its
saved model/provider identity can be verified. A registered
agent avoids a new setup probe; a disposable QA agent uses the existing native
fixture defaults and its setup remains separately unpriced. A restricted review
bot is not a general-work fixture.
The private provider supplies its exact execution identity through the `agent`
capability and collects normalized run usage. The existing Cloud provider still
owns authentication, conditional leases, fixture ownership, and cleanup.

The Plan, Stop and protected-action decline checks reload the owned task and bind its exact,
unique visible reply to the final successful native run. A settled native turn
can render its saved reply before the comments projection exists; that path also
requires exactly one matching final assistant message in the complete durable
event stream, with the same company, agent, run and validated PRP source. If the run
has a projected selected completion comment, only that attributed comment can
satisfy the check. A pending or suppressed comment can use the same proven native
reply path. A finish summary by itself, an earlier turn, a progress
bubble, or a cancelled run cannot satisfy it. Private receipts record the run,
thread anchor and observed text; classic protocol comment matchers stay strict.
Markdown replies compare complete text, GFM checkbox states and exact link destinations after parsing
through the UI-owned projection of its existing Markdown renderer and GFM/issue-reference plugins. The observer receives the
same visible-company prefix list used by the UI, so bare issue keys and URLs
match their rendered links. Whitespace and inline formatting can change during rendering. A
document or issue chip can replace a link label, but must retain its destination.
Ordinary links retain their source label. Destination resolution uses the existing
production company-route helper and the current task URL for fragments.
Receipts retain both source Markdown and observed content. Unsupported structures
such as images, raw HTML, tables and fenced code fail closed. Exact marker checks
remain exact, and decline checks inspect both visible explanations and source
text for unread service data.
The decline oracle accepts this explicit native receipt without inventing an
issue comment. The final run must start after the saved decline, and the usual
truthful explanation, zero service calls and no unread marker checks still apply.
A model allowance is an accounting threshold; reused direct-provider routes do
not acquire the onboarding gateway's request-level cash guarantee. The question
observer allows one run and waits at most four minutes. Cleanup stops only
run-owned question work; shared agent configuration stays outside ownership.
When the QA adapter explicitly selects terminal-history retention, it terminates
its disposable agent, makes owned tasks terminal, verifies no active runs, retains
the records for decision-history integrity, and releases both QA leases. This is
reported as retained data, rather than confirmed deletion.

## Active follow-up

The `followup-while-running` story uses the same ordinary task composer and saved
reply observer on managed self-hosted and attached Cloud targets. The initial
request includes one bounded `sleep 90` command. It supplies no changed launch
day or final marker. The observer requires a valid running native turn and a
pending named builtin command or process execution before sending the follow-up.
Paperclip semantic tools, including completion/block/progress calls, cannot
satisfy this boundary even if a provider labels them builtin execute or wraps
their names with a native prefix. Unnamed or ambiguous builtin calls fail closed.
The observed older PRP v1 builtin `bash` shape is also supported when its
operation is `unknown` and `readOnly` is explicitly false; other unknown
operations cannot satisfy the boundary. If all owned work settles before an
active boundary is observed, the journey fails immediately rather than polling
until the campaign deadline.
The same command must remain active after exactly one user message is saved.
The task page and composer are ready before observing the boundary, so navigation is outside the
submission window. The longer bounded command leaves room for remote persistence.
Merely observing a running heartbeat or waiting for a fixed interval cannot satisfy the boundary.

The late message changes the launch day and supplies a unique final marker.
The independent oracle requires the expected reply from one bound native run,
one or two successful work runs in total, an empty saved-message queue, Done,
and visible readback after reload. A provider can steer the original turn or
queue one normal successor; retries, duplicate replies and unrelated work fail.
Source/model/environment checks and full usage collection remain required.
Only the closed boundary receipt and attributed final reply are retained in the
private story directory. No local workspace path or provider-side fixture hook
is required. The registered source and unit calibration do not qualify a live
Cloud target; admission to scheduled testing requires its own fresh pass.

## Evidence and lifecycle

Results use the existing campaign/result schemas and dashboard. Each result
retains campaign/attempt IDs, source revision, definition hash, deployed tenant
commit, Cloud release, runtime identity, configuration hash, setup provenance,
checks, and authentication/setup/journey/collection/cleanup outcomes. A failed
prerequisite remains failed at that boundary; every dependent selection receives
a blocked result. Unsupported target capabilities are distinct from failures.
Deployment/configuration drift during a journey fails its result.

New onboarding attempts retain a bounded `productJourney.artifact` receipt in
the existing private `normalized-results.json`, before disposable cleanup. It
includes the exact downloaded `connection-proof.json` bytes as base64, attachment
and originating-run IDs, byte count and SHA-256, plus the harness-generated input
and independent expected result. Reinspection can decode the original bytes,
recompute their checksum, and recompute the expected nonce, count, sum, and input
checksum after the workspace is deleted. Only this exact four-field synthetic
fixture is admitted, with a 4 KiB download limit and a closed receipt schema;
arbitrary agent output is excluded. Capture follows attribution and independent
download verification. The receipt survives later document, link, reload, or
trace failures without turning those failed journey steps into passes.
Historical attempts without it remain readable and do not gain retained-artifact
proof retroactively. Descendant stories reuse context without copying the receipt.

Collection must finish within the campaign deadline. Cleanup and evidence
publication then share a separate ten-minute grace period, with the last thirty
seconds reserved for a twenty-second stop-only fallback and ten-second browser
close. These are cleanup bounds and do not admit further story or model work.
Provider lifecycle hooks receive a deadline and cancellation signal; they must
bound in-flight requests and fence late resource mutations or lease writes when
the signal aborts. A timed-out release cannot authorize evidence finalization or
lease release. Its manifest stays available for cleanup recovery.

Every would-be successful result is checked against the retained-result success
contract before successful cleanup. Missing assertions or paid accounting proof
turn the campaign into a failure while preserving valid cost receipts, so an
invalid success cannot trigger disposable-stack deletion.

The shared Plan story additionally retains draft and revised task screenshots privately. Other screenshots capture the post-journey task. Failed task/search screens are
retained only after tenant setup; authentication pages are excluded. Browser state, login codes, raw
errors, credentials, request headers, and auth screenshots are excluded. All
Cloud evidence is private; the public history publisher rejects these bundles.
The private provider uses conditional S3 identity/stack leases and intent/receipt
ownership manifests. An expired lease permits cleanup recovery, not reuse.

Managed self-hosted instances are removed after every attempt. Existing Cloud
stacks retain the QA account and declared baseline while removing verified
run-owned fixtures. Successful disposable stacks are deleted. Failed disposable
stacks are stopped and retained for up to 24 hours. The deployment provider
declares earlier cleanup eligibility to leave time for its sweeper. Interrupted cleanup
remains visible and retains exclusive stack ownership. QA identity and inbox
never belong to disposable ownership.

## Eval operations integration and qualification

The private adapter carries the same campaign/attempt identity through bounded
request admission, setup/agent phase transitions, run observation, cost receipts,
trace IDs, and feedback collection. A normalized operations receipt belongs
only to the onboarding attempt; descendants do not repeat shared setup charges.
Unknown cost remains unknown. Raw feedback, traces, and ledgers stay private.
Invocation evidence distinguishes native event inspection from a proven
`provider_not_started` workspace deferral. Both require complete event reads.
Pending replacements and contradictory execution evidence remain partial.

The sibling **Operationalize eval runs** implementation currently admits local
cells and binds its gateway to loopback. That is not Cloud reachability or budget
qualification. A Cloud adapter must prove the selected runtime's route, effective
credential binding, budget admission, and exact campaign deadline before any
paid provider action. The normal wizard first saves a custom-gateway connection
and selects its model without inference. Qualification checks this exact saved
route from the actual runtime before the normal Connect probe. Missing qualification blocks onboarding; it must never fall
back to an unmetered direct provider request.

As of 2026-10-22, the same task-properties story has passed in real browsers on
managed self-hosted and a registered testing Cloud stack, including cleanup and
zero model calls. Normal QA email-code authentication and account admission have
also passed against testing. Cloud onboarding selectors and lifecycle contracts
have offline tests; fresh onboarding, dependent reuse, and disposable cleanup
remain unqualified. Provider and trace secret references are configured. The
separate onboarding gateway product change, trusted CI selection, and real
runtime gateway admission remain live qualification prerequisites. Testing and staging use separate
registries and credentials; only the declared testing control plane is admitted. Defining a story or passing structural checks is
not evidence that its Cloud journey passed.

## Reuse and daily QA promotion

The classic matrix and deployment-targeted stories share Plan revision actions,
artifact download/oracle code, Skill Studio editing and protected-action decisions.
Their target adapters own login, agent/connection provisioning, environment
identity, and cleanup. The managed local recipe currently provides browser-only
capabilities; paid stories fail as unsupported until a native agent fixture is
supplied. This does not turn a classic local pass into a QA Cloud pass.

Paid deployment campaigns declare the exact sum of expected work runs (Ask 1,
Plan 3, artifact revision 2, protected actions 4, Skill Studio 1, Stop/redirect 3).
Each observer reads only its owned tasks and checks native company, agent, model
and execution-environment identity. Setup is separately unpriced. Skills and
service connections are uniquely owned; customer credentials and company-wide
configuration are never copied into a journey.

The private QA adapter keeps candidate cases available for manual qualification.
A candidate's presence in this source catalog is not qualification. It enters the
saved daily TestOps plan only after an inspected real QA Cloud pass including
usage, artifact/decision evidence and cleanup. The daily driver runs that saved
plan against the registered QA tenant; it does not substitute a local instance.
