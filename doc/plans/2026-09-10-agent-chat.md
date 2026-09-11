# Persistent agent chat, backed by tasks

Date: 2026-09-10
Status: Implemented behind `enableAgentChat`; verification recorded in the implementation handoff.

## Contract

Each person has one persistent conversation with each agent in a company. A conversation is an ordinary issue with fixed `conversationAgentId` and `conversationUserId`, a matching agent assignee, and a unique company/agent/user identity. The authenticated board actor supplies the user identity (`local-board` in local trusted mode). Company task authorization still applies: these are separate conversations, not private messages.

Opening an unused conversation performs a read. First send or upload resolves its backing issue atomically through `POST /api/companies/:companyId/chats/:agentRef`. `GET` on the same path returns the existing issue or null. Comments, documents, files, interactions, runs, and subscriptions use the existing task APIs. User chat comments require a stable `clientRequestId`; retries return the same comment. Comment rows also provide a durable delivery outbox, serialized across servers before admission to the normal execution queue.

Idle conversations are `in_review` with server-owned `conversationState: waiting`. A new message makes the conversation active. A successful run parks it only after a durable agent response, with no later pending message. Failed or unanswered turns retain ordinary error handling. Finalizers, assignment recovery, liveness classification, timer eligibility, and work counts distinguish conversations from execution tasks. Completion or reassignment cannot terminate or transfer the container. Child completion does not wake the conversation.

## Session boundaries

Standalone `/new` is an ordinary queued user comment. The shared composer offers it as a slash command. It executes at a turn boundary without invoking the provider, increments `conversationSessionGeneration`, and records `conversationBoundaryCommentId` plus the generation on the command comment. Processing a retried command is idempotent. Only the matching agent/task provider session is deleted; agent-wide state and other task sessions are untouched.

A board-authored `/new` also releases pause holds rooted at the chat without waking the stopped turn. Dispatch admits the verified reset even when the previous turn has a no-replay recovery disposition; after the boundary, that old disposition remains auditable but does not block a fresh session. Pending clarification questions from the old session expire, including questions configured to survive ordinary comments. The reset run adds no empty-response notice.

Provider-session writes and run-authored replies check the generation. Cancelled conversation runs cannot issue mutating API calls, post late replies, or restore provider sessions. Fresh prompt replay is bounded to nondeleted comments after the boundary and before the current wake comment, with source-trust sanitization. Automatic task continuation summaries are omitted for conversations. History, artifacts, plans, and linked tasks retain their IDs and remain available for explicit inspection. The shared transcript renders processed command comments as session dividers.

## Agent policy

`server/src/services/agent-conversations.ts` owns the chat directive. The task prompt includes it on initial turns, retries, resumed turns, and fresh sessions. It asks the agent to clarify material gaps, then create and assign ordinary project tasks with outcomes, context, copied plans, and acceptance criteria before claiming they exist. It explicitly overrides ordinary completion and accepted-plan execution instructions for the container. Ask mode stays non-mutating; plan mode supports clarification and planning. Normal tools, approvals, budgets, assignment, and execution policies continue to apply.

## Shared production composition

`TaskDetailSurface` in `IssueDetail.tsx` is the shared controller and surface. `AgentChat.tsx` resolves the canonical task and provides an ephemeral view model before the first write. It does not implement a second transcript, composer, file panel, or run controller. The chat presentation hides task metadata and the seeded description bubble, uses task breadcrumb typography with agent avatar/name and a configuration-page gear, and defaults the existing task side panel to artifacts/plans rather than Properties.

Company-prefixed `chats/:agentRef` routes open the current person's conversation. Direct task URLs remain supported. The existing Agents roster provides a Chat action. The shared sidebar lists starred agents alphabetically, then four recent unstarred conversations, without a divider. Stars appear on hover or keyboard focus. Existing resource memberships store stars; company/user-scoped recent-navigation storage records conversation visits only. The gear goes to agent runtime configuration; See all agents goes to `/agents/all`.

## Rollout

`enableAgentChat` defaults to false in the shared feature catalog, validator, server settings, and Experimental settings UI. Navigation, resolution, new messages, and reset commands are gated. Turning the flag off preserves data, allows already-running turns to settle, and prevents new chat execution. Lifecycle protection is independent of flag state; task links remain readable under normal authorization.

## Verification

Database and route tests cover concurrent canonical creation, independent users with ordinary company visibility, client retry identity, cross-company denial, local identity, ordered concurrent delivery, separate queued resets, generation fences, replay boundaries, idle recovery classification, disabled admission, and child wake suppression. Shared composer/sidebar/settings tests and Storybook fixtures cover the production composition. Storybook scenarios include first conversation, returning, working, paused, failed send, long history, session boundary, disabled feature, light theme, and ordinary task comparison.

Required handoff checks: targeted tests; token gates; Storybook build; repository typecheck, tests, and build; browser checks of first send, session divider, stars, switching, drafts, configuration, roster, and disabled states. Fixture navigation is not a claim of a live provider evaluation: task creation quality remains prompt-guided and should be observed during the experimental rollout.

### Implementation verification — 2026-09-10

- Repository typecheck (`pnpm -r typecheck`), production build (`pnpm build`), token gates, and Storybook build passed.
- Final UI suite: 563 files, 5,622 tests passed. The shared controller/live-update regression pass covers first send and upload, preservation of agent routes, read-only unused conversations, personal live-update resolution, and durable session-divider refresh.
- General server lane: 8,345 passed and 38 skipped initially; the four failures (a stale module loaded during editing and three socket disconnects) passed in a fresh 68-test rerun. The conversation suite also executes a real process adapter: two ordinary turns invoke it twice, `/new` invokes it zero times, and each answered turn returns to idle.
- All 144 serialized route suites were exercised. The skill-route socket failure and queued-comment fixture cleanup failures passed in a 70-test rerun. Queue test cleanup now clears its full company-scoped foreign-key closure rather than ignoring failed deletes.
- Shared, database, CLI, adapter, skills-catalog, and plugin project suites passed. The CLI migration test exposed and verified the cloned-database constraint upgrade fix. Adapter suites that exceeded the default five-second timeout passed with capped workers and a 30-second test timeout. Tests ran against isolated temporary homes and databases; repository-standard unsupported integration cases remained skipped.
- Browser checks used the production composition with fixture APIs: first send, retry and draft retention, agent switching, stars, configuration/roster navigation, linked subtasks, paused-agent controls, disabled navigation, long history, and `/new` preserving earlier messages and plans. Live-update unit tests cover the socket/cache behavior independently of Storybook fixtures. No live-model task-handoff quality evaluation was performed.

The broad `pnpm test:run` attempt was followed by isolated group/file reruns for the failures above; this is not a claim that the initial monolithic command exited successfully. The experiment remains off by default.

## September 11 reset regression verification

The initial live demo checked an idle reset but missed Stop followed by `/new`. In the reported Claude run, dispatch cancelled both the reset and follow-up before reset processing; the provider generation stayed at zero, and the cancelled old turn posted a late reply. Regression coverage now includes pause plus a prior no-replay recovery disposition, reset and immediate follow-up queue order, cancelled-run write rejection, expiring persistent clarification questions, and suppressing empty reset-run transcript notices.

Live Codex and Claude checks confirmed fresh context after pause → `/new` → follow-up. An additional Claude check stopped an actively streaming turn containing a unique code word, reset, and asked for that word without history inspection. Claude reported it was absent; the chat returned to waiting.

### Agent chat project handoff (2026-09-11)

Chat supports research and full plan drafting/revision in its existing plan document. On handoff, each ordinary assigned task receives the relevant plan in its own `plan` document, committed with task creation before execution is scheduled. The source plan remains in the conversation. Plan acceptance hands off execution; it never switches the conversation into implementation.

Chat instructions require selecting a suitable project, reusing an existing one where appropriate. The project requirement is prompt-only; ordinary projectless tasks remain supported. New parent relationships beneath conversation tasks are rejected by task services, including direct API creation and reparenting. Existing children remain readable/editable and can be moved elsewhere. The Subtasks panel is unchanged.

The `create_project` runtime tool uses the normal project API with durable idempotency. `list_projects` and `list_project_repositories` support selection. Multiple `repositoryIds` select authorized catalog entries; multiple HTTPS GitHub `repositoryUrls` register existing repositories absent from the catalog. IDs and URLs may be combined, but cannot accompany an explicit `workspace`. URLs do not create repositories on GitHub or grant credentials. Execution uses normal repository access rules. Repository IDs are revalidated against the authenticated run's responsible user and connection grants. Agents should consider proper available repositories, clarify material ambiguity, and use repository-free projects when appropriate for non-code work.

Confirmed project creation appears as a durable card in the shared task transcript, including selected repository links. Tasks are linked inline. Failed creation never produces a success card. Tool evals cover planning/handoff, project/repository selection, retries, permission and mode denials, and ordinary delegation regressions using the production chat directive.


### Project handoff verification (September 11)

The real-server tool tests cover concurrent project retries, task/plan atomic creation, ordinary child delegation, import/reparenting rejection under conversations, mode restrictions, cancellation, repository URL normalization, and committed project cards. The ordinary task review-path guard now exempts conversations; the server owns their waiting state after a successful reply. The chat directive explicitly tells agents to reply and end their turn without inventing a reviewer or changing status.

Five focused Codex live evals passed: existing-project reuse, new project/task handoff, multiple repository URLs, plan-only drafting, and authorized repository discovery. Four provider-free contract evals passed for retries, missing access, Ask-mode denial, and persisted handoff plans. The companion harness has 30 passing tests. The qualified Claude eval profile could not start on macOS without its explicit eval credential (it additionally requires Linux x64); it was not bypassed.

A separate local Claude agent drafted and revised a chat plan, created Garden Club Demo through the dedicated project tool, and created normal assigned task AGE-7 with its initial plan. The plan was persisted at 16:47:51.426 UTC before execution started at 16:47:51.492 UTC; the task completed with an output document and the original chat plan remained. Local Codex created Repository URL Demo with two URLs absent from its catalog; both appeared on the inline card and project configuration. The card persisted across reload and `/new`. Light and dark production-composition stories were inspected in the browser.

The broad general-server run reported 8,362 passing tests and two failures from pre-fix modules cached before the review guard and explicit-workspace card changes. The fresh current-source API run passed all 21 tests across four files, including both regressions. Remaining repository groups are verified separately so the initial monolithic exit is not represented as a clean pass.

The full UI lane passed 5,626 tests and the CLI passed 484. The shared and skills-catalog projects passed. The remaining database/adapter/plugin group passed 2,365 tests; a migration startup failure passed alone (1 test), after reducing workers to avoid embedded-Postgres contention. Existing unsupported integration tests remained skipped.

Both serialized server shards are now verified: all 144 suites passed across their final runs/resumed segments. An outdated project-route mock and the new MCP transport's missing OpenAPI inventory entry were corrected; embedded-Postgres startup failures passed in isolated retries. The API catalog now includes the task-run-only MCP transport and points project discovery/creation to their dedicated tools; its focused suite passed 824 tests. The catalog census has 792 operations (555 authored REST contract cases).

Repository-wide typecheck and build, Storybook build, and token gates passed. The final API metadata change also passed server typecheck/build. Two follow-up Codex live cases passed with the final directive, and all 11 retained deterministic/live artifacts passed the stronger persisted-state scoring, including detection of unintended tasks created through API fallback. These results do not turn the earlier failed monolithic test command into a clean run.


### 2026-09-11: E2E regression coverage

Persistent conversations now have dedicated `tests/e2e/agent-chat.spec.ts`
coverage using a deterministic process adapter against a disposable real server.
The authenticated suite additionally checks separate canonical chats, personal
stars/recency, shared company visibility, and cross-company denial for two people.
The runner catalog registers `agent-chat`: six scenarios on four local
Codex/Claude profiles (24 paid cells). See `tests/runner-e2e/README.md` for launch
commands, credential preflight, evidence, and reset/child-run accounting.

Browser testing identified a company-cache shape mismatch in chat live updates
and a dropped reset marker in compact run summaries. Preserve the shared cache
contract and `conversationReset` summary field so messages refresh live and reset
boundaries do not render empty model-completion notices.

Local acceptance on 2026-09-11: all 20 deterministic chat scenarios and two
existing repository browser scenarios passed against a fresh test instance.
The new authenticated two-person scenario passed independently. Runner fixture
checks passed (121 tests), and the live-update/run-summary regression checks
passed (46 tests). Repository typecheck, build, Storybook build, and token gates
passed. Paid Codex and Claude smoke attempts failed credential preflight because
`OPENAI_API_KEY` and `ANTHROPIC_API_KEY` were unavailable; the 24-cell matrix is
registered but has no claimed paid passing coverage from this run.


### 2026-09-11: Paid runner regression fixes

The first GitHub campaign exercised all 24 cells and exposed provider-session,
queue/lifecycle, plan-review, and shared-feed issues. Follow-up work uses focused
provider-free regressions first, then individual paid cells on disposable
instances; the running demo remains untouched.

Claude session serialization now retains its MCP server identity. Conversation
containers ignore dependency and child-completion wakes, while pending questions
and plan reviews count as durable replies and settle the conversation to waiting.
Rejected plan feedback is included in both full and resumed prompt assembly;
acceptance resolves the implicit current-task target and hands off the selected
plan revision before execution begins.

Native provider handling preserves FIFO events and terminal schema, projects
committed normal replies into chat, and verifies ownership when a restored ACPX
session lazily launches its provider during model selection. Linux Codex preflight
uses an exact executable AppArmor profile and a provider-free sandbox probe. The
focused GitHub campaign `34638268637` passed native Codex continuity/restart and
fresh-session reset on both selected cells.

The shared project card hydrates repository links from the authorized project
record while retaining its original durable creation receipt. Regression coverage
checks a second repository arriving after creation, reload, and `/new`. Handoff
fixtures check committed repository workspaces and actual output documents rather
than assuming URL registration adds an entry to the external connection catalog
or requiring an unspecified output document key. Failure classification avoids
paid retries for explicit non-retryable provider-session failures.

All 20 deterministic chat browser scenarios and Storybook build passed after
these fixes. Focused live checks additionally passed legacy Codex project reuse
and repository handoff, legacy Claude plan revision/acceptance/handoff, and native
Claude planning, Stop/reset/resume, fresh sessions, and multiple repositories.
Final campaign results and broad verification are recorded below when complete.

The next full campaign (`34640536416`) reached 18/24 passing cells and identified
three additional issues. Execution prompts now include the task's persisted plan
and selected revision on both fresh and resumed runs; a plan handed off without a
description therefore still reaches its executor. Native durable redaction keeps
explicit literal/exact acceptance identifiers while continuing to redact actual
credential-shaped values. Recovery for an older conversation generation or an
already answered turn cannot block a reset or healthy idle chat. Regression tests
also preserve recovery for current unanswered turns and unprepared failures.

Fixture assertions now accept concrete clarification requests without requiring a
question mark. They check the approved revision and final execution output rather
than rejecting an old draft quoted in plan revision history. Restart verification
opens the canonical chat route after reconnecting, preserving the continuity and
no-unsolicited-run checks. Stable inconsistent idle states fail promptly instead
of waiting through a long timeout and hiding a product race behind a paid retry.
Focused native Claude project reuse and multiple-repository handoffs, and legacy
Claude multiple-repository handoff, passed on their first attempts with these fixes.

The focused legacy Claude Stop/reset/resume regression also passed on its first
attempt. Latest repository-wide typecheck, build, and token gates passed. Final
runner fixture checks passed 151 tests; fresh chat/prompt/recovery checks passed
209 tests, and the native session executor file passed 207 tests. Broad local
verification is recorded as resumed groups rather than a clean monolithic run:
the original command encountered source edits during execution, generated-evidence
scanner input, and cold-import/process-startup timeouts under concurrent load.
The guidance scanner now excludes only generated runner evidence and has a
regression proving authored runner guidance remains scanned. Focused UI, database,
publication, and canonical-path CLI reruns passed without product changes.

Broader adapter verification exposed OpenCode test fixtures reading the developer's
real configuration directory. Those fixtures now allocate and restore isolated
XDG configuration directories; all 44 source tests and package typecheck pass.
The remaining workspace projects were run even after earlier groups stopped at a
failure, and the original failure logs remain available alongside focused reruns.

Campaign `34642700703` passed 19/24 cells. Its remaining failures were traced to
one clarification-oracle phrasing, revision-write guidance, runner teardown after
a successful restart, and native mutation content passing through diagnostic
redaction. The clarification fixture now also recognizes substantive requests
for a brief or details. Revision instructions and HTTP conflict errors explicitly
map the GET `latestRevisionId` to PUT `baseRevisionId`; a live Codex
plan/revise/accept/handoff run passed on its first attempt with that fix.

Playwright now gives the restart supervisor a bounded SIGTERM shutdown so it can
reap children and close log streams. A real zero-provider Playwright regression
verifies restart, child process exit, and port closure; cleanup failure still
fails the campaign. Native schema-declared task/project/document prose retains
its complete contents while credentials and diagnostic data remain scrubbed.
Regression coverage includes long plans beyond the diagnostic preview limit.
The macOS fake Anthropic service now clears inherited nonblocking socket mode
before its bounded request read; all 271 Rust library tests passed afterward.

All 144 serialized server suites have passing coverage across the resumed shards
and focused reruns. Three route fixtures moved cold module imports into bounded
setup hooks, preserving their HTTP assertion timeouts; the final affected files
passed 119 tests. The completed workspace groups likewise have passing focused
reruns for every observed failure. These results are recorded alongside, rather
than replacing, the earlier failed monolithic invocation.

The ACPX sidecar decoder was an additional execution boundary: it applied generic
diagnostic redaction before the native semantic-input stage. It now uses the same
schema-declared prose policy at decode. The regression feeds a real
`runtime.tool_called` event through decoding, pending-call state, and semantic
projection, checking complete long-plan contents, protected credentials, unknown
operation handling, and matching content digests. The decoder/state checks passed
22 tests and durable-state checks passed 30 tests before the next paid campaign.

The final local native Claude repository handoff preserved the exact previously
corrupted task description, plan, and execution output. Its product assertions
passed on the first attempt; post-run secret scanning then exposed PostgreSQL
removing `instances/<id>/db/postmaster.pid` after directory enumeration. Only
ENOENT for that exact transient path is now tolerated. Existing PID contents,
other scan errors, mandatory evidence, and process/lease cleanup remain enforced.
All 157 runner fixture tests and final repository typecheck/build passed.
Campaign `34645293835` tests the complete set of fixes.

Campaign `34645293835` passed 20/24 cells. Two failures exposed narrow lifecycle
races: a successful native chat turn could be mistaken for productive unfinished
work before response publication, and an agent comment deferred behind an active
execution could wake its assignee after that execution completed. Recovery now
leaves the first case to the conversation finalizer; queue promotion cancels the
stale terminal-task continuation while retaining human reopening and notifications
to other agents. The recovery regression fails with the guard removed and passes
with it restored; all 20 comment-wake batching tests and server typecheck pass.

The other failures distinguish requested approval from ordinary draft planning,
and a persisted Paperclip document from a workspace file. The chat directive now
explains how to create a revision-bound approval card when explicitly requested,
including after a revision. Paid fixtures name the requested Paperclip document
explicitly while retaining strict checks of approvals, transferred plans, and
persisted execution output.

Native reconciliation also preserves assessment lineage within its owning run
when the task's previous status decision belongs to a different run. Decision
lineage still spans runs; the database ownership constraint remains unchanged.
The regression reproduces the original foreign-key failure without the fix and
passes for absent, same-run, and different-run predecessors with it. The next
24-cell campaign is `34646672139`, pinned to `3556fa25f`.

Campaign `34646672139` passed 23/24 cells: all native cases and all legacy Claude
cases passed. The remaining legacy Codex plan-revision failure exposed an adapter
prompt omission. Its resume delta discarded the server's task-context Markdown,
including both the chat directive and document-concurrency guidance. Codex now
selects the same full/compact task-context Markdown as Claude on initial and
resumed sessions. Both adapters suppress generic task-completion and child-task
planning directives in chat, leaving the central chat policy authoritative.
The approval and output assertions remain unchanged.

Fresh chat prompts use a small conversation-safe default template that retains
connection guidance, permissions, budgets, cancellation, and mutation honesty.
Explicit custom agent templates remain intact. Native execution and continuation
prompts also carry the conversation flag so shared wake rendering cannot reinsert
ordinary completion/subtask instructions. The integration regression inspects
both fake-CLI stdin and the recorded adapter invocation with the production chat
directive; removing the task-context section reproduces the failure. Shared prompt
checks (102), actual Codex prompt cases (3), native resume checks (11), affected
package typechecks, and server typecheck pass. Campaign `34648511170` tests all
24 cells on `abacbdfd2`.

The complete Codex/Claude execution regression files passed 46 tests. Final
repository-wide typecheck and build also passed on `abacbdfd2`, after all prompt
changes.

Final paid verification: campaign `34648511170` passed **24/24** chat cases on
`abacbdfd2`: legacy Codex 6/6, legacy Claude 6/6, native Codex 6/6, and native
ACPX Claude 6/6. All cells completed by 21:34 UTC on September 11, within the
requested three-hour repair window. No acceptance assertions were disabled.

- [Exact campaign results](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-34648511170-1/summary.md)
- [GitHub run and retained evidence](https://github.com/paperclipai/paperclip/actions/runs/34648511170)

The [HTML dashboard](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-34648511170-1/index.html?report=agent-chat#suite-agent-chat)
was repaired from retained evidence after its older trusted catalog omitted the
branch-only suite. It now includes the chat suite and 32 screenshots, including
eight draft/revised plan captures recovered from their original Playwright
attachments. No paid cells were rerun; result records, tested SHA, timestamps,
usage, billing, attempts, and cleanup outcomes remain unchanged.

Reporting now discovers validated display-only entries for unknown selected
execution IDs, and publication rejects missing declared screenshots. The exact
chat plan filenames are included in packaged evidence. All 165 runner unit tests
and runner TypeScript checks passed. Browser verification covered suite
filtering, restored plan images, and gallery navigation. This explicitly
authorized repair replaces only this campaign's report objects; normal
immutable-publication protections remain unchanged.

The published summary and normalized results were verified after publication:
exactly 24 unique expected cells, all passed on attempt 1, all cleanup checks
passed, all evidence valid with no evidence errors, and every result bound to
`abacbdfd2f660709ec37312cdb758284c8399d04`. The public report returned HTTP 200.
