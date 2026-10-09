# Native connection guidance: audit and eval preparation

## Decision

Keep production connection instructions intact in this slice. The current
fixtures cannot justify removing all of the repeated text: decline prompts
teach the no-retry behavior, the old provider-decline grader permits an empty
explanation, and several boundaries have no direct live oracle. This change
prepares a separate neutral comparison suite and preserves the existing cases.
It does not claim that either production text or the new live journeys passed
a model comparison.

Audit base: faa8e452c73bae5e044dd6379179a00106abb131.
The preceding hiring-only experiment #15389 remains a separate failed
qualification. Its results do not establish connection behavior.

## What reaches the model

| Layer | Delivery | Relevant source |
| --- | --- | --- |
| Native fixed prompt | Session instruction context | packages/paperclip-runner/src/contracts/runtime-context.ts |
| Connection discovery and request descriptions/schemas | Granted tool catalog; subject to provider/catalog delivery | server/src/services/connection-tool-definitions.ts and packages/shared/src/connection-intent-guidance.ts |
| Shared connection guidance | Legacy prompt/environment delivery and native task-context tool results | packages/adapter-utils/src/server-utils.ts and server/src/services/native-runtime/paperclip-runner-tool-authority.ts |
| Search, request, and outcome instructions | Returned as the operation/state is encountered | server/src/services/connection-intents.ts |
| Assigned connection instructions | Optional per-connection runtime context, separate from fixed guidance | packages/paperclip-runner/src/contracts/runtime-context.ts |

The fixed connection span is 98 whitespace-separated words / 654 UTF-8 bytes
including its trailing space. The complete fixed prompt is 262 words / 1,713
bytes. These are source counts, not provider tokens, billed usage, every
configuration's total prompt, or proof of upstream loading/truncation.

The existing full-catalog capture measures nine scripted provider/phase
projections plus an authenticated OpenCode MCP tools/list. Its source manifest
now also hashes the shared connection text, tool-definition source and input
validators that supply these bytes. The captured catalog contains 41 supplied tools. All three providers have
normalized projections of 53,341 bytes at start/resume and 50,949 bytes for
compact continuation; the authenticated MCP tool catalog is 48,195 bytes.
The connection search/request descriptions are 651/503 bytes and their schemas
248/611 bytes. The fixture has API tools enabled and no
assigned external apps. Per-connection instructions, app catalogs, private
vendor prompts, and runtime results are not silently counted as standing text.

## Rules that must survive a later reduction

- Explicit connection requests must search before using even an installed
  service. Ordinary work can use installed access without unnecessary setup.
- Provider discovery is not human consent or proof of underlying app access.
  Saved provider choice and permission gates remain authoritative.
- The actual request tool creates setup or Grant access cards. Do not invent
  access or solicit credentials in task comments.
- Complete independent work, then yield. Do not poll or repeat requests while
  waiting. Continue from the saved outcome and refreshed tools.
- Respect decline and use an alternative when possible. An explicit human
  request is needed to reconsider a declined provider choice.

The search/request descriptions and result instructions already carry much of
this procedure. They do not by themselves prove every model discovers it, nor
does moving words into descriptions prove a lower total instruction load.
The fixed decline/alternative rule and optional access-grant paths need explicit
coverage before removal. No prompt revision or session compatibility changes
are needed while production stays byte-identical.

## New executable coverage

The manual-only native-connection-guidance suite has five cases on local native
Codex, ACPX Claude and OpenCode, for fifteen configured cells:

| Case | Independent boundary |
| --- | --- |
| service-approve | No fixture call before approval; one afterwards; saved briefing contains actual titles and hidden marker |
| service-decline | Saved refusal; no call or replacement request; attributed post-decision explanation |
| connection-decline | Real Notion setup card; Not now saved; no connection or repeat; attributed explanation |
| provider-decline | Real provider choice, restart/reload, None saved; instrumented installed gateway receives zero calls; attributed explanation |
| provider-second | Saved second-provider choice after restart; no early call, one chosen-provider call; actual marker and no duplicate setup |

Decline prompts contain a user-permitted fallback but no no-retry, decline,
tool-selection, polling or completion-protocol instruction. They still define
the requested deliverable: a brief explanation if data is unavailable. This
allows Done without pretending that unfinished required work is complete.

New explanation checks join comment.createdByRunId to a successful run with the same
agent and native issue. They reject absent/stale/wrong-agent/wrong-task output,
missing decision timestamps, unrelated decisions, duplicate requests, missing
call evidence, unauthorized calls and connection changes. They check saved
output, not cognitive consumption or arbitrary prose truthfulness. Existing
screenshots and the original independent workflow checks remain in use.

Each cell has one attempt, expected two provider turns, a twelve-run ceiling,
a 720-second deadline and verified 1,000-cent company/lead budget hard stops.
The bound is a ceiling, not a target. The selected provider supplies its normal
model profile and permissions. No production or workflow credentials are
changed. No paid campaign is started by defining or testing this suite.

## Remaining coverage before any broad connection reduction

A single saved interaction does not prove that an agent avoided repeating an
idempotent request-tool call. This suite rejects duplicate saved decisions,
not every repeated tool invocation.

Successful new authentication/setup and tool refresh, existing-connection
agent grants, useful independent work before yielding, explicit reconsideration
after decline, arbitrary provider compatibility, and unavailable access with
remaining mandatory work need separate oracles. A passing subset cannot
qualify these missing behaviors. Positive approval of an already installed
service is not successful connection creation.

## Validation and disposition

Local support validation passes 1,424 TypeScript tests and 128 Node checks.
The six full-catalog measurement tests, repository typecheck/build and Product
E2E typecheck pass. Exact suite discovery lists fifteen local cells and tests
confirm exclusion from default/generic selection. The pre-rebase full test invocation was stopped when master advanced. Its
partial log is not a pass. The branch was replayed onto master
`a6306ba606eb87c89b9ef0344e9fe8e0025580f9`, retaining the upstream Cursor catalog
additions. The measurements above remain tied to the original audit base.
Post-rebase verification and source CI/review are pending at preparation.
The initial support run exposed catalog-size expectations needing the fifteen
new cells, and typecheck caught an unknown comment-body input; both are fixed
and the final support/typecheck runs pass.

This PR changes no production instruction, tool-description, authority or
runtime file relative to its master parent. Upstream runtime changes during
the rebase are not instruction savings from this PR. There is no baseline/candidate behavioral score yet and no paid
usage in this preparation slice. Preserve historical failures and report any
future original attempt without rerolling a usable behavioral failure.
