# Persistent cases with same-task agent handoffs

## Outcome and boundaries

A case is a persistent record that can exist without execution. Starting its
workflow creates or explicitly binds one ordinary primary task. Each handoff
reassigns that same task, preserving its thread, workspace, execution policy,
responsible user, and each agent's own task session. Agent prompts choose phases;
existing task and review controls decide whether execution is allowed.

The implementation extends standalone `cases`, not experimental `pipeline_cases`.
It uses the existing database and delivery coordinator. There is no graph editor,
configured transition graph, external workflow service, or separate case assignee.
Ordinary case and task completion remain independent. An explicit terminal
handoff to `done` closes the case on accepted completion of its primary task.
If a passive case retains several
unrelated private task boundaries, automatic kickoff fails closed when a new
ordinary task cannot preserve them; an eligible existing primary task is required.

## Persistent contract

Cases add `workIssueId`, `phase`, and `handoffVersion`. One task may be primary
for one case. `case_handoffs` records authenticated intent, the expected and
applied task revisions, instructions/comment, delivery identity, and retry lease.
Its states are `awaiting_release`, `pending_dispatch`, `delivered`, and `cancelled`.
Delivery means durable wake acceptance, not proof of agent execution.

`case_access_sources` retains source task/project identities. Access requires the
intersection of their existing permissions. Unlinking or deleting a source never
publishes its contents. Lists, documents, revisions, annotations, assets, audit
feeds, and live events enforce the same boundary. A newly started case normally
inherits its primary task's access. Existing passive cases retain their sources.

`POST /api/companies/:companyId/case-handoffs` and the live `handoff_case` tool
share a transaction and idempotency contract. Subsequent handoffs require observed
case and task versions. A retry with the same principal/key returns the same
receipt, including after the source run ends. Different input under that key fails.

The outgoing run yields after acceptance. The harness fences its task mutations
and waits for observed provider exit and workspace/session settlement before
applying assignment. Stop and later operator changes supersede pending delivery.
Native completion represents handoff as an incomplete, server-verified yield.
Ordinary review/approval gates cannot be satisfied by a phase name.

## Acceptance matrix

| Journey | Required evidence |
| --- | --- |
| Passive case | No task or run created |
| Kickoff | One primary task, handoff comment, receipt, and successor |
| Round trip | Same task through triage, implementation, verification, correction |
| Return to agent | Fresh instructions with its compatible existing task session |
| Duplicate/concurrent requests | No duplicate assignment, comment, or provider execution |
| Restart | Committed intent and accepted wake recover without repeating work |
| Source still active | Recipient waits for provider and workspace settlement |
| Stop/stale completion | Old intent/output cannot override the winning task decision |
| Private record | Source permissions cover all reads and copied outputs |
| Review gate | Existing verdict/approval still required |
| UI | Current owner and waiting recipient are distinguishable; retry failures visible |

## Implementation state

Work is on `codex/persistent-case-handoffs` in the existing isolated checkout.
Schema, shared validation, migration, access policy, transactional service,
delivery worker, runtime bindings, context, and minimal UI are implemented.
Verification uses embedded PostgreSQL, production services/transports, actual
process adapters, and the real native runner with a scripted Codex provider.
Presence of implementation is not a claim that live qualification passed.

## Verification evidence (2026-10-19)

| Check | Observed result |
| --- | --- |
| Standalone case routes and shared request validation | Latest case suite 24 tests and shared validator suite three tests passed, including retained-source privacy, assets after unlink, audit filtering, pipeline fallthrough, source attribution, denied low-trust mutations and cross-company history/retry/cancel behavior |
| Handoff service and actual legacy process workflow | Latest run 24 tests passed, including concurrent/replayed intent, worker restart/leases, accepted wake acknowledgement loss, private boundaries, disabled cleanup, HTTP source fencing, rejected recipients, cancelled instructions, skill-test scope, historical quarantine and actual-parent assignment authorization |
| Assembled native workflow | Passed with real runnerd and scripted Codex app-server: live tool call, automatic accepted yield, actual source process retirement, same-task successor and fresh context persisted through `write_document` |
| Native executor regression | 744 tests passed after correcting the feature-gate integration |
| Final affected case integration | 57 tests passed across six suites after trust/scope hardening, including the actual native runner and legacy process paths |
| Final authorization hardening | Protected/cyclic implicit parents use ordinary allowed fallback; protected retained private parents fail without partial work. Cross-company present/absent cases return indistinguishable 404 responses for history/retry/cancel. Native integration passed again after the parent fix. |
| Runner schema compatibility | 85 strict contract/dispatch tests, 29 authority tests and four coordinator tests passed after replacing unsupported UUID format metadata with the canonical UUID pattern |
| Startup registration | 50 affected startup tests passed; explicit durable-worker registration and signal forwarding covered |
| Runtime queue and run controls | 26 tests passed; separate queue-module suite 25 passed, including assignment races and cancellation/feature-disable admission |
| UI and live updates | Case detail, task cases panel and workflow section tests passed. Final live-update suite 72/72 and authenticated WebSocket suites 14/14 passed, including populated/empty task-only caches, UUID/identifier history and denied case/task access. Browser screenshot inspected from the isolated provider attempt. |
| Repository typecheck and build | Both completed successfully twice; generated runner checks and Rust release build passed. Final affected UI typecheck/build and server build passed again after parent, route-gate and live-update fixes. |
| Migration structure | Migration numbering/safety passed with 20 existing baseline findings; five newest snapshots retained. Direct source-to-snapshot comparison for 0357 produced zero migration statements. The separate five-second Vitest snapshot test timed out; its failure remains recorded. |
| Token gates and capability maps | Passed; map validation covers structure, not live execution |
| Original full `pnpm test:run` | Stopped after its general-server run recorded two 15-second timeouts (chat and file resources) and 53 native executor fixture failures. Both timed-out tests passed unchanged in isolation; all 744 native executor tests subsequently passed after the integration fix. Full-catalog verification is being repeated through the repository's supported isolated CI shards. Preserve the original invocation's failures. |

The complete server catalog was subsequently exercised through all four general
and all four serialized CI shards: 1,172 files and 25,184 tests were collected.
Those original shard invocations were not green: 18 files failed, including
intermediate-source UUID/schema failures, incomplete test doubles, a missing
route authorization guard, cold-import/startup timeouts and one socket hang-up.
Every failed server file subsequently passed a fresh focused run after the
relevant fixes. The original failures are retained in
`/private/tmp/case-check-server-*.log` and
`/private/tmp/case-check-serialized-*.log`; this is not a claim that a single bulk
invocation passed.

Focused reruns preserve the original assertions and time limits. Later UI/route
reruns use Vitest 5's supported `--fsModuleCache` and `--fsModuleCachePath`
options to reuse validated compiler output under shared-host load. One longer
ownership-import diagnostic was excluded from acceptance evidence; the final
ownership/comment run passed all 267 tests with normal limits. Responsibility
invariants passed 14/14 unchanged, device login 41/41 twice, historical questions
33/33, agent secret bindings 9/9, connection fixtures 6/6, environment routes
20/20, live-run routes 91/91, CLI auth 24/24, retry lifecycle 15/15 and the static
cross-company authorization guards 2/2.

All workspace projects were exercised. The fail-fast wrapper stopped before CLI
and before the remaining adapter/plugin projects, so those were explicitly run
with the same isolated home/config/temp conventions, two workers and compiler
caching. No project was silently omitted.

| Workspace catalog | Observed result and remaining qualification gap |
| --- | --- |
| UI | Original bulk run: 754 files, 8,541 tests, five failures in three files. The live-update fixture was corrected and its stronger final suite passed 72/72. Unchanged IssuesList remains 43/50 with seven five-second timeouts; AgentToolsTab remains 5/7 with import timeouts and subsequent late React cleanup errors. One isolated tree test also exceeded five seconds. |
| Shared, catalog, adapters and plugins | All 17 projects covered: 312 files, 4,964 tests; 4,937 passed, seven failed, 20 skipped. Remaining unchanged five-second timeouts: ACPX execute four, git workspace sync one, GitHub launcher one, Grok auth copyback one. Per-project results are in `/private/tmp/case-b-recovery-RebfIL/results.json`. |
| CLI | Full 66-file run: 533 passed, six failed, one skipped test. One bounded serial rerun of all three failed files yielded 77 passed, three failed, one skipped. Remaining failures: two large-archive five-second timeouts and worktree reseeding blocked by PostgreSQL shared-memory allocation. Import/export's test was skipped because its beforeAll server-health deadline expired, not because the capability was intentionally disabled. |
| Database | Original 52-file run: 117 passed, ten failed, 73 skipped tests. Failures were PostgreSQL bootstrap/resource failures or time limits, with no reported schema-diff assertion. An additional serial rerun was stopped after approximately 13 minutes of rotating startup/collection probes under confirmed host IPC exhaustion; it is not green evidence. Direct schema/snapshot equality passed separately. |

Full-suite qualification remains **incomplete**. The CLI PostgreSQL error was
`shmget(size=56): No space left on device`; a read-only host check found 31 of 32
shared-memory slots occupied while the disk had approximately 1.4 TiB free.
No running database could be attributed to this task's logged isolated roots;
no unrelated database, IPC object, system limit or test timeout was changed.
The database support probe can run during module collection, before ordinary
Vitest test/hook deadlines, so startup retries are not reliable acceptance under
that host condition. The bounded reruns and original failures remain separate
evidence. The serial database rerun was explicitly interrupted (exit 130).

The remaining verification path is to run the standard repository checks on a
host with available PostgreSQL IPC capacity and enough CPU for the existing
five-second tests, then repeat the one configured-provider workflow below.
No further rendering, archive, adapter or database retries are running.

The configured-provider smoke was attempted in an isolated instance using the
existing Codex subscription. Kickoff created case
`bbd95339-6f8b-4cf8-b99b-f7c00585b4be` (`RUN-C1`) and primary task
`3b6eabdd-01f9-456d-8dc6-5abcff8705b1` (`RUN-1`). Its first native run,
`23411a41-7596-4c14-9987-513be8999c0f`, was rejected by Codex with HTTP 429
and `responseTooManyFailedAttempts`, before completing triage. The provider
round trip and returning-agent provider-session reuse remain **unqualified**.
The deterministic native test is separate evidence, not a replacement claim.

The retained attempt is under
`tests/runner-e2e/results/local-2026-10-19T13-40-41-760Z/` (ignored generated
evidence), including `snapshots/chat-final-run-ledger.json` in its attempt
directory. Two preceding attempts stopped on test-fixture errors before
workflow execution; redacted configuration reuse and exact-case screenshot
admission were corrected. All attempts retain their own evidence and cleanup
records. No operator login/config/session files are committed.

To repeat provider qualification after access recovers, select only
`case-handoffs.runner-codex-subscription.local.same-task-roundtrip`; see
`tests/runner-e2e/README.md`. The attempt has one automatic try, a bounded turn
count and company/agent budget stops.

## Read-only case pages — 2026-10-19

Implemented the approved Storybook design in the production Cases and CaseDetail
pages. The stories now mount these pages with HTTP fixtures; there is no separate
prototype renderer. Cases support URL search/status/type/project filters,
No project, and authorized server paging. Detail reads saved fields, current
work, documents/revisions, attachments, relationships, activity and handoffs;
case mutation and handoff recovery controls are absent. Task controls and agent
REST APIs retain their existing authority.

List work context is batched, and the distinct-types endpoint uses the same
retained-source access policy. A discovered stale-preview gap is addressed by
scoped document/revision cache invalidation and document revision activity/live
events. The mobile revision comparison pickers fit the dialog. Case work has a
named landmark, and dark status-chip text has AA contrast on its tinted fill.

Verification for this UI change:

- 100 focused UI tests across case pages, fields, task links, revisions, activity,
  and live updates passed. UI and server TypeScript checks passed.
- 27 real PostgreSQL case route tests passed, covering authorized paging/types,
  constant query count, private metadata, revision publication and attribution.
  OpenAPI mounted-route coverage passed.
- Production UI build, token gates, map checks and 28 catalog/map tests passed.
- Storybook production-page search → inspect → document → return play passed.
  List retry play passed, and the final detail accessibility scan reported zero
  violations (31 passing checks).
- A separate local-trusted instance from this dirty checkout, using fresh embedded
  PostgreSQL and production HTTP routes, was driven from Cases navigation through
  No project, search, case detail, current document, two stored revisions, and
  return with filters retained. Closing the document restored focus. At 390px,
  the built production UI had no page overflow and both Diff pickers were visible;
  the case detail contained no editable inputs. This was a record-reading test,
  not provider-execution qualification.

The disposable acceptance case was CAS-C1 (`3f733ea1-cd9b-4413-b80b-4ae099e38e95`),
primary task `ec7b291e-3fee-49d3-b0b6-3d04188f18b3`. Local launch/doctor records
are in `/private/tmp/paperclip-cases-ui-proof-v2-20261019/`; screenshots are in the
Codex visualization workspace for this chat. Repo-wide checks/provider smoke
were not repeated for this UI iteration; their earlier limits remain recorded
above. No production data or deployment was changed.

## Small receipt acceptance workflow — 2026-10-19

Added the explicit-only Product E2E cell
`case-handoffs.runner-codex-subscription.local.receipt-smoke`. It routes one task
through triage, builder, verifier and returning builder. The first saved receipt
is `{total:6}`; the verifier saves `{totalCorrect:true,missing:["currency"]}`;
the returning builder reads the review and creates receipt revision two with
`{total:6,currency:"USD"}`. The task completes while the case remains draft.
Two passive cases support browser filtering. The independent oracle checks
document/run attribution, nonoverlapping runs, delivered routing revisions,
fresh context, native tool receipts, idempotent kickoff and browser readback.
Read-before-write proof uses correlated production-redacted API request hashes;
raw API arguments and bodies remain redacted in run events.

Bounds are four task work runs, daily role caps 1/2/1, one concurrent run,
90 seconds per run, low reasoning effort, one five-minute attempt and configured
100-cent company/agent budgets. Production setup also performs small hello
inference outside heartbeat accounting. Its tokens/cost are unavailable and are
not zero. Setup is observed serially with a 45-second readiness deadline and
immediate failure on lifecycle errors; cleanup pauses agents. This is not an
absolute four-inference or dollar cap.

Retained live attempts, both with automatic retries disabled:

- `tests/runner-e2e/results/local-2026-10-19T17-04-22-166Z/`: fixture setup race
  left triage verifying/paused and its work run queued. It was stopped before
  any work execution. Setup hello calls may have occurred/retried and their
  usage was not measured. Removed the redundant configuration PATCH and added
  readiness admission before kickoff.
- `tests/runner-e2e/results/local-2026-10-19T17-11-06-380Z/`: all three agents
  became ready; kickoff and replay created one case/task/handoff. Case
  `1f44b430-e930-4275-9196-bb2f45dccd40` (`RUN-C3`), task
  `591ce311-59bd-4638-9174-abf342ab33ec` (`RUN-1`), native triage run
  `62cafab4-ac88-423a-b11a-8f239221be6e`. The first work turn was rejected with
  HTTP 429 / `responseTooManyFailedAttempts`; it ran about ten seconds and the
  browser attempt lasted 35 seconds. Cleanup passed. Token/cost coverage is
  unavailable. No receipt or review was produced.

The second attempt also failed the persisted-home exact-secret scan on a local
Codex rollout file. The guard's failure remains the machine result; its standard
report is in that campaign's `merged/index.html`. The underlying HTTP 429 is
retained in Playwright evidence. The matched category cannot be determined after
normal temporary-home cleanup: structured login matching includes identity
metadata as well as credential tokens. No raw rollout was published; publication
manifest leak/missing lists are empty. Do not exempt rollout files or interpret
this as a successful provider qualification. Future investigation should retain
nonsecret match-category attribution with synthetic canaries before any further
live attempt.

These attempts used the dirty checkout based on
`023f4a5d0cd452c540ddd0deb4a0b81ef5e2ff92`; their original source fields are null
and their own definition digests remain retained. The stricter redacted
read-before-write oracle was calibrated afterward and has not been live qualified.
Focused final support checks passed 294 tests, including 119 receipt calibrations;
runner E2E TypeScript, exact-cell discovery and map/diff checks passed. Broader
support verification encountered an unchanged macOS filesystem watcher test
(`remote-native-fixtures.test.ts`, transient create/delete mutation count zero),
which still failed on a serial unrestricted rerun. No repo-wide build/test pass
is claimed for this test-only iteration; earlier feature qualification limits
remain above.

### Provider-free browser acceptance

`tests/e2e/cases-read-only.spec.ts` passed against the shipped production UI,
fresh embedded PostgreSQL and public APIs: 2.8 seconds for the journey and
23.4 seconds including server startup. It creates three passive cases, an
unassigned reference task and two receipt revisions. Chromium enters Cases
through the visible sidebar, filters by project/status/type/search, opens the
record, reads both revisions, closes with Escape and restores focus, returns
with filters intact, reloads and checks a 390px viewport. Before/after API
snapshots are equal; no browser case mutation, agent or heartbeat run exists.
Teardown restored the feature flag and archived the disposable company.

Accepted fixture company: `e69d3f47-e17f-46d2-baf7-fb118962349d`; receipt case:
`35d46e8a-4ca6-475d-a7e2-8a204b858e73` (`REA-C1`); reference task:
`90c82519-ac43-45ff-9d67-cfc3e663c8ae`. The standard Playwright report is
`tests/e2e/playwright-report/index.html`, with three screenshots and the full
unchanged-state proof attached. This test makes no inference calls. It proves
record browsing and persistence; it does not replace the failed live handoff
qualification above.

Three preceding browser fixture failures are retained under
`/private/tmp/cases-read-only-browser-{first,second,third}-attempt/`: the empty
dashboard opened onboarding, missing distinct case keys caused an upsert, and
the latest-revision label joined its number to “latest.” The fixture now enters
through Tasks, uses explicit keys and matches the actual accessible revision
names. Independent bounded `afterEach` cleanup preserves the original journey
error instead of masking it on timeout. No product/API behavior was changed to
make these assertions pass.

### Provider failure diagnosis and API recovery

A read-only probe of the same bundled Codex 0.160.0 client confirmed
`ordinaryUsageAllowed:false`, weekly usage 100%, with a reset of October 24 at
9:14 PM America/Chicago. Both `gpt-5.6-sol` and `gpt-6.1-sol` are available;
unsupported model selection was not the cause. Only initialize,
account/rateLimits/read and model/list ran, with no inference. The isolated
credential copy was removed. Sanitized evidence is retained in
`tests/runner-e2e/results/case-receipt-recovery-2026-10-19/subscription-quota.json`.

The user supplied an API credential source; only `OPENAI_API_KEY` was loaded
privately. Its model catalog includes the unchanged `gpt-5.6-sol`. Added
`case-handoffs.runner-codex.local.receipt-smoke` using the existing encrypted
company-secret fixture. The subscription cells remain distinct; the historical
arithmetic cell was not extended to API authentication. API roles preserve their
secret references instead of applying subscription-home overrides.

The first API attempt, `local-2026-10-19T17-44-00-385Z`, completed four successful
nonoverlapping native runs and passed all eleven independent workflow checks.
Case `f5a67014-69fe-42be-b28c-53fef3b4e9c8`, task
`fcbe7093-10fc-4fa4-a757-4bf793ff2906`. It then failed an ambiguous browser
locator: “verification” matched the phase and a sender's agent name. That failed
grade remains retained. The selector now matches the exact phase descendant;
handoff counting uses the outer history list. Credential scanning, artifact
publication checks and cleanup passed. Its temporary private home was removed
after packaging; retained evidence contains no raw credential/session files.

Secret-scan diagnostics now label only safe source fields (for example,
`CODEX_AUTH_JSON.tokens.account_id` versus `access_token`) and preserve the
original run failure in a sanitized `persisted-state-scan.json` snapshot. No
scan exclusions or failure gates were relaxed. Synthetic identity/token canary
and streamed-file tests verify the new labels without printing matched bytes.
The original subscription scan match remains unclassified because its raw
temporary file had already been removed; the separate API attempt passed the
same persistence gate.

The selected packaged runner is darwin-arm64, SHA-256
`56b31bc48d0d9dfd7a3239e6275d6501e7b41b331553cc9d495936d3898c2e12`, built
October 19 at 9:22 AM Chicago; the server copy is byte-identical. It contains
the case-handoff continuation contract. Final focused support verification:
552 tests passed across 20 files; runner E2E TypeScript and three-cell discovery
passed. These checks do not erase earlier broad-suite limitations.

The second API attempt, `local-2026-10-19T17-50-06-954Z`, passed all eleven
workflow checks and its browser journey in 166 seconds. Its machine grade
remains failed: the new special-case harness branch omitted the canonical
`final-state.png` and `snapshots/api-state.json` required by evidence packaging.
Credential scanning, publication checks and cleanup passed; its private home
was removed after preserving sanitized evidence. The case-handoff branch now
captures the verified final task page and saves allowlisted current task,
case and run facts with matcher results. Packaging requirements remain intact.
Runner E2E TypeScript and 444 focused checks passed after this fix.

### Live receipt acceptance

The final API attempt, `local-2026-10-19T17-56-25-856Z`, passed the complete
Product E2E cell: four real native Codex task runs, eleven independent workflow
checks, browser list/filter/detail/document revision assertions, evidence
packaging, exact-secret scans and cleanup. Journey duration was 129,998 ms;
Playwright including isolated server startup took about 2.5 minutes. No automatic
retry ran. The standard report command also passed for the exact selected ID.

- Company: `a1f612d7-f7c1-425a-8ec0-5622d3a6fc1f`.
- Case: `0b6f65c0-dfe5-4c67-af64-4b84813aadde` (`RUN-C3`).
- Primary task: `ed97f870-0fde-431f-85e2-aee8a69c9afb` (`RUN-1`).
- Runs in phase order: `946d827f-3e4e-42b8-add4-2448ad201580`,
  `342e8f7f-22e9-4d01-b7ad-d9804cdfd840`,
  `101ac7d3-1ddb-4b28-9f32-f521b497e5c8`,
  `7f67bc5e-8bb7-4ede-a702-a9ad4a23c60a`.
- Final receipt revision 2: `{"total":6,"currency":"USD"}`; independently saved
  review: `{"totalCorrect":true,"missing":["currency"]}`.
- Task is `done`; case remains `draft`, phase `revision`, version 4, with no
  pending handoff. All four handoffs reference the same primary task.
- Report: `tests/runner-e2e/results/local-2026-10-19T17-56-25-856Z/merged/index.html`.

The published evidence manifest has no leaks or missing files and includes both
canonical final artifacts. The disposable credential/server/database home was
removed. Earlier failures above remain retained with their original grades.
This qualification used the API profile; it does not resolve the exhausted
subscription profile or retrospectively classify its original secret-scan match.

Work-run usage coverage is four of four runs: 153,541 input tokens, 3,981 output
tokens, and 660,979 cached input tokens (818,501 total). Production context,
rather than the tiny receipt payload, dominates tokens. Provider dollar cost is
unpriced and setup hello usage remains unavailable; zero reported dollars must
not be interpreted as free inference. Use the provider-free browser test for
routine UI iteration and this four-turn cell for occasional live acceptance.

### Terminal destination amendment

The user requested a prompt-level `handoff_case` destination of `done` to close
the case. This supersedes the initial agent-only destination restriction.
Existing agent handoffs retain their input and yield/delivery semantics.
An alternative `to: "done"` accepts only an existing case with a primary task,
the two observed versions, principal idempotency and final instructions. It
records `destinationKind: done`, no recipient and `awaiting_completion`, without
yielding or changing task status/assignment. Normal completion remains required.
Task completion and terminal case closure settle together in the ordinary
issue-service transaction, including native accepted completion. Review and
human waits preserve the intent. Reassignment, Stop and task cancellation
invalidate it. Disabling cases blocks new requests but permits admitted intent
to settle during normal task completion. Ordinary completion without intent
continues to leave cases unchanged. Passive cases retain their existing CRUD.

| Required outcome | Verification owner |
| --- | --- |
| Strict union contract, old input compatibility, durable migration | Contract/schema worker |
| Authorized idempotent request, no assignment or wake, current versions | Handoff service worker |
| Normal completion closes atomically, legitimate waits remain open | Runtime worker |
| Stop/reassignment/rollback and native non-yield behavior | Runtime worker |
| Read-only pending/completed history and current context/guidance | Root |
| Four real native turns ending with a fifth terminal ledger entry | Root |

Historical reports above retain their original grades and earlier case-draft
contract. New acceptance must use the revised definition digest and report.

Terminal implementation verification: shared contracts 12/12; runner contracts
106/106; capability inventory checks 4/4; real-PostgreSQL application service
41/41; runtime/Stop/lifecycle regressions 37/37; native assembled completion
and other focused runtime checks 15/15; existing legacy handoff/heartbeat
checks 8/8; read-only UI 16/16; Product E2E support/oracle selection 497/497.
Workspace-wide typecheck and build passed; server typecheck passed again after
the final Stop fix and public request-input type correction. Token gates,
migration checks, five-snapshot retention, map checks and Storybook catalog
generation passed. The full repository test command is tracked separately below.

Independent review caught a Stop-versus-acceptance gap: intent cancellation
previously committed before source writes were fenced. Stop now records
`executionCancellation: requested` under the same task/run locks and transaction
as cancellation. Real database races for agent and terminal destinations prove
that a fresh handoff cannot be accepted in the process-termination gap. A later
review found no remaining blocker in those inspected paths.

Terminal live acceptance passed in campaign `local-2026-10-19T19-14-18-642Z`:
four real native Codex work runs and eleven independent workflow checks, including
the new terminal receipt, plus production browser readback, packaging, secret
scans and cleanup. Journey duration was 163,229 ms; Playwright with isolated
server startup was about 3.9 minutes. No automatic retry or fifth run occurred.
Company `4f479fd6-c780-49d2-8709-4f7d8c4f1830`, case
`95584a08-2a0c-4b21-970d-48cf583ad32c` (`RUN-C3`), primary task
`eacd82f3-56f8-409b-b6e9-dee36682ae50` (`RUN-1`). Both case and task are done;
case phase is `done`, version 5, and no handoff remains pending. Terminal
handoff `bae80098-30d0-41e7-b6d4-e47955307dd2` and case share completion time
`2026-10-19T19:17:56.884Z`. Standard report generation passed:
`tests/runner-e2e/results/local-2026-10-19T19-14-18-642Z/merged/index.html`.
The manifest contains no leaks/missing evidence, and the private test home was
removed. Work-run usage: 166,022 input, 4,236 output and 842,772 cached input
tokens. Dollar cost is unpriced; setup probe usage remains unavailable.

The full `pnpm test:run` invocation was started in this iteration and remains
separate from those completed checks. Its live log is
`/private/tmp/case-done-workspace-tests.log`; it was still running the serial
general-server group after terminal live acceptance. No full-suite pass or
PR-ready qualification is claimed from this partial repository run.

### Completed-task pause notice correction

The terminal live report above exposed a UI defect despite passing the workflow
oracle: a manually paused assignee displayed a warning and Resume action on a
task already marked done. The report's canonical final screenshot follows fixture
retirement, but the earlier task capture also has the warning; retained evidence
does not establish when that earlier pause became visible. Existing reports and
grades remain unchanged.

The shared paused-assignee notice now receives task status and hides for done
or cancelled work in both task interfaces. Reopening restores the warning while
the agent remains paused. No agent lifecycle or permission behavior changes.
The real receipt journey now rejects this warning before its final task capture.
Focused chat regression tests pass (329/329), UI and runner-E2E typechecks pass,
and token and map checks pass. A separate provider-free browser journey exercises
real APIs, persisted status changes and both production task interfaces; its
evidence is recorded separately from paid workflow acceptance.

Provider-free browser verification passed in both interfaces (2/2), including
done → todo → cancelled → todo → done. Status, assignee controls and composer
finish loading before absence assertions. Both fixture agents stayed manually
paused and each company retained zero heartbeat runs. Root inspected the
completed and reopened task screenshots. The independent read-only review found
no actionable issue. Report:
`tests/e2e/test-results/terminal-paused-agent-2026-10-19/report/index.html`.

### Native case tools and continuation context

Added production `read_case`, `update_case`, `read_case_document` and
`write_case_document` for standard native runs with cases enabled. Omitted case
IDs resolve the primary workflow case; explicit IDs resolve only authorized
standalone cases. Fact updates expose title, summary and whole-object fields,
excluding status, routing and permissions. CRUD retry receipts are scoped to
the admitted run; handoff replay remains principal-scoped. Both dedicated tools
and REST retain ordinary permissions, source trust, attribution and revisions.

The native adapter reuses real authenticated routes. Case read/update selects
document metadata in SQL; default REST/UI responses remain compatible. Explicit
document reads accept the existing bounded 200k-character document schema,
including JSON escaping, through a server-only 4 MiB inline allowance. The
model receives the body once. Generic API inline limits remain unchanged.
Stop/handoff fencing and copied-source retention now share the case write
transaction. Large captured case responses retain both case and run-owner
boundaries; revoking a retained source cannot leave a readable captured asset.

The previous description that full context reaches the provider on every wake
was too broad. Ordinary verified native continuations already used event deltas;
case handoffs previously used the full prompt again. Native case continuations
now carry fresh identity, phase, versions, read paths and new instructions, with
facts only when their fingerprint changes. The fingerprint covers summary,
fields, document revisions and accessible references. It excludes routing and
history changes. Proof comes from the actual admitted native input and exact
company/agent/task/session/base-run identity, not merely a prepared snapshot.
Cold, reset, unknown-format and failed-resume paths retain the full snapshot.
Authorization still refreshes each admission, and provider history still grows
by one new message per phase. Legacy adapters retain their existing snapshot.

Deduplication preserves edited messages and deletion tombstones. Only identical,
nondeleted source text already represented by the current projection may be
omitted. Deleted source comments produce explicit withdrawal guidance rather
than reusing their retained old instruction body.

Deterministic actual model-envelope JSON sizes with an 8 KiB case field:
10,276 bytes cold, 1,085 bytes unchanged resumed, 9,462 bytes after changed fields
and document revision. These are input bytes, not token or dollar measurements.
Verification: 210 runner contract tests and generated-output checks, full runner
build/vendor refresh, 85 focused continuation/projection tests, 42 real-database
case tests, API/HTTP tests (2,055), additional route/capture/assembled native
checks (40), redaction tests (10), and receipt support tests (128) passed. The
final body-alias cleanup passed its real HTTP suite (8) after the live smoke
server had loaded the preceding helper; that final cleanup is not independently
qualified by the concurrently running provider attempt. Workspace typecheck and
build passed.

Broad verification limits remain explicit. The restricted E2E support run had
40 failures from local process/socket restrictions. The unrestricted run passed
2,911/2,916 tests; four installed-CLI checks rejected inherited NODE_PATH and all
14 checks in that file passed with a clean direct-Node environment. The remaining
unchanged filesystem-watcher test failed independently of the application:
raw node:fs.watch on this Darwin host delivered no events, even for a persistent
file over two seconds. No observer check was weakened. The earlier full
repository suite was stopped as superseded while still incomplete, preserving
`/private/tmp/case-done-workspace-tests.log`; no full-suite pass is claimed.

The new native-tool live campaign `local-2026-10-19T19-57-00-135Z` passed all
12 independent checks in one attempt with four real `gpt-5.6-sol` runs on the
same task. Triage persisted `inputsValidated`, implementation saved the receipt,
verification independently found the missing currency, and returning
implementation saved revision 2 (`{"total":6,"currency":"USD"}`) before terminal
handoff closed the case and task. Browser readback, report packaging, secret
scans and fixture cleanup passed; the private test home was removed. Report:
`tests/runner-e2e/results/local-2026-10-19T19-57-00-135Z/merged/index.html`.
Company: `010427e2-38cf-460a-a965-7856f1552bad`; case:
`f2b7c609-8ca0-4ca7-a687-6e4f42a5e829` (`RUN-C3`); task:
`df01ea0e-3007-4428-b171-d662a120027f` (`RUN-1`). The work runs reported
133,781 input, 3,101 output and 521,496 cached-input tokens, with usage coverage
for all four runs. These are recorded provider usage categories; the report
does not establish an invoiced dollar total.

This attempt used fresh provider sessions for all phases, including returning
implementation. Its saved task-session row lacked the effective configuration
fingerprint, so normal compatibility validation correctly reset it. Audit found
the handoff early return in run completion skipped ordinary session persistence.
The live pass therefore proves tools and workflow behavior, while compact
returning-session behavior requires its separate deterministic evidence and the
session-persistence correction; do not describe this campaign as live proof of
compact resumption.

The correction reuses the ordinary runtime/session persistence block before
releasing an accepted handoff. It stores the source agent's returned session,
effective configuration fingerprint and source run identity; ordinary completion
retains its prior ordering. Missing or incompatible metadata still resets the
session. No session or authority crosses agents, and no compatibility rule is
relaxed. The assembled regression now follows A → B → A and a later same-agent
phase, distinguishing B's legitimate fact/document changes from unchanged facts.
Its initial run passed all 27 completion tests but failed the new return path
because the scripted provider reused a static settled turn ID. The runner
correctly failed closed. The fixture now emits unique turn identities and
preserves the resumed thread identity; production protocol checks are unchanged.
The original failure log is retained at
`/private/tmp/case-handoff-session-persistence-tests.log`.

The strengthened fourth-phase test then exposed a separate production gate:
its valid new handoff remained `pending_dispatch` with `wake_not_admitted`, and
its wake receipt was `skipped` for `issue_rewake_throttled`. Two previous
successful case phases had no issue-scoped progress activity, and an
agent-authored instruction comment made the generic no-information throttle
classify the new phase as a repeated wake. The diagnostic record is retained at
`/private/tmp/case-handoff-session-roundtrip-diagnostic.log`.

The queue now exempts only a validated durable case-handoff request from that
generic cooldown. The receipt is checked against the persisted company, task,
recipient, preallocated wake ID and assignment version, and revalidated under
the admission transaction lock. It is not accepted by public wake schemas.
Budget, pause, permissions, task guards, source release and duplicate admission
remain authoritative; ordinary agent-comment throttling remains unchanged. No
test advances time or extends its wait to hide the incorrect classification.

Final deterministic qualification passed: 27 completion-boundary tests, 30
queue/throttle tests and the actual native A → B → A → A workflow (1/1,
33.55 seconds). The workflow verifies persisted source session/fingerprint and
run identity, real `thread/resume`, compact continuation envelopes on both
returning turns, fresh changed facts, unchanged facts omitted with no original
canary, each new instruction once, and final case/task completion on the same
task. The native test uses the actual runner with a controlled provider; no
additional paid attempt was made. Final server typecheck passed.

An intermediate four-suite run passed the 30 queue/throttle tests and failed
only a fixture expectation that omitted the server's authoritative handoff
comment heading. The final assertion includes the exact heading and retains
the once-only/content-omission checks. That log is preserved at
`/private/tmp/case-handoff-session-roundtrip-comment-prefix.log`; final assembled
pass: `/private/tmp/case-handoff-session-roundtrip-final.log`. These results
qualify the subsequent session and throttle fixes deterministically without
regrading the earlier fresh-session provider campaign.

The final server build, map checks and whitespace checks passed after these
corrections. The earlier workspace build/typecheck passed; full repository test
qualification remains limited as recorded above.

### Native creation and task-owned initial documents

The subsequent product decision replaces new case-owned document work with
ordinary task documents and a case read rollup. Existing case document records,
revisions and REST APIs remain compatible; no migration, copying or deletion is
performed. The separate native case-document tools are retired.

Native `create_case` accepts case metadata plus optional
`kickoff: {toAgentId, phase, instructions}` and `initialDocuments`. Without
kickoff it creates a fresh passive record and returns no task. Its native REST
transport uses explicit `createOnly:true`; legacy default upsert semantics stay
unchanged. Passive receipts are run-scoped and reauthorize current case access
before identity is returned. An interrupted HTTP response retains the existing
safe `api_outcome_unknown` behavior rather than guessing or repeating creation.

With kickoff, creation delegates to the existing principal-idempotent handoff
service. The agent-handoff input also accepts top-level `initialDocuments` when
creating the first primary task of an existing passive case. Keys use ordinary
task normalization, duplicates are rejected, and limits are 20 documents with
200,000 total body characters. Task rows, documents, revisions, attribution,
ordinary document activity and delivery intent commit together, before any
recipient wake. Existing primary tasks, existing-task binding and terminal
handoffs reject nonempty initial documents; ordinary task tools own revisions.

Case detail adds bounded, authorized `taskDocuments` references carrying task,
key, revision and read-path identity. Execution context references the same
documents without bodies. Canonical task permissions, company scope, quarantine
and system-key filtering precede the document budget. Historical case refs
remain distinguishable. The read-only case UI loads task documents and revision
history through ordinary task APIs and reuses the shared revision/diff display.
There are no editing controls.

Deterministic verification passed: shared validation 25/25, real PostgreSQL
handoff/route tests 79/79, native authenticated HTTP tests 9/9, runner contract
tests 118/118, API/redaction tests 2,058, rollup/projection tests 27/27, UI/revision
tests 13/13, and receipt evidence tests 148/148. The actual native runner
A → B → A → A test passed with passive `create_case`, a seeded task brief read
before the first transfer, ordinary task document writes/reads, compact session
reuse and final completion. Its first fixture attempt incorrectly expected
`latestBody` rather than the ordinary task API's `body`; the failed log remains
`/private/tmp/create-case-native-assembled.log`, and the corrected pass is
`/private/tmp/create-case-native-assembled-final.log`. No production read
contract was changed to satisfy the fixture.

The fresh-browser test initially omitted the ordinary task API's required
`format` field (preserved initial report); the corrected run then exposed a
reload filter reset. Radix's empty initialization value must not clear an
explicit URL filter, so the existing filter component now accepts only listed
options; explicit "all" still clears. The unchanged browser assertion passes
after this correction. The final journey passed in 3.4 seconds against a fresh
real API/database, including task-document preview, owner link, both revisions,
close/focus, filter restore after reload and mobile layout. Persistence snapshots
match before/after, with no case writes, agents or runs. Root visually inspected
the revision preview and mobile screenshots. Final report:
`tests/e2e/test-results/create-case-task-documents-2026-10-19/verified/report/index.html`.
The earlier reports remain in their separate initial/final directories. The
filter's focused UI tests passed 7/7. The initial restricted workspace typecheck
failed on tsx IPC permission; the unrestricted rerun passed. Earlier provider
reports remain immutable and do not qualify this subsequent ownership change.

Final workspace typecheck and build passed. The first build correctly detected
generated capability-index drift after the case guide's headings moved. Official
generators refreshed the skill heading inventory using the real evaluation
corpus; all 106 evaluation rows and 42 legacy aliases stayed unchanged. Two
consecutive runner builds and normal vendor refresh passed with input digest
`1580c44e8030`, followed by the complete workspace build. Map, token and
whitespace checks passed. Full repository `test:run` was not repeated for this
bounded change; the focused service/transport/runtime/UI suites above establish
its deterministic scope.

The first live task-document campaign, `local-2026-10-19T21-32-43-612Z`,
completed all four provider runs on task `0ab67ddb-71a7-4f2c-a4d5-f255def79554`
and closed case `571f41b0-db65-43e0-a34c-3c0dbbb41fee`. The seeded task brief,
handoff contexts, document-read receipts, corrected receipt and final closure
were present. The returning builder reused its persisted task session. The
campaign remains failed (11/13): ordinary task revision responses omitted the
stored `createdByRunId`, so the strict artifact provenance checks could not
prove which runs wrote the receipt and independent review. The ordinary
authorized revision read now includes that existing nullable field; it grants
no access to run contents. This is an API projection fix, with no schema
migration or relaxation of the oracle. The failed campaign and its generated
report remain preserved. A new campaign must qualify the subsequent fix.

The revision projection fix passed six real-database document tests and seven
canonical route tests with the unchanged 15-second timeout. Two route tests
timed out in the first combined run while loading the large issue router; that
log and a longer-timeout diagnostic remain preserved. The final route-only
confirmation loaded the router in 11.475 seconds and passed all seven tests in
14.26 seconds. Server/shared typechecks and subsequent builds passed. Tests
prove two real writer-run IDs survive persisted revisions, human writes remain
unattributed to a run, and denied task reads return 404 before fetching revision
contents or provenance. No access rule or stored data was changed.

The subsequent live API-key campaign `local-2026-10-19T21-39-45-440Z` passed
13/13 receipt checks and the real-browser journey in one attempt with automatic
retries disabled. Its four provider runs completed on the same task
`a0afa6e2-4595-4ff4-b66c-2dfb452afb8c` (`RUN-1`), and case
`43c35c5a-59b9-470e-9fce-be01db8615c2` (`RUN-C3`) finished as `done`, phase
`done`, routing version 5. Triage read the seeded ordinary task brief, the
builder saved revision 1, an independent verifier persisted its review, and
the returning builder read that review and saved revision 2. Both receipt
revisions now expose their actual writer-run IDs, so strict provenance checks
passed unchanged. The returning builder reused the first builder's persisted
session (`01a1561c-ab86-72e3-938c-f09b945fa7b3`), with both `sessionReused`
and `taskSessionReused` true. No overlapping or extra run occurred.

The recorded workflow duration was 134.288 seconds; full isolated startup and
browser execution took about 3.1 minutes. Recorded per-run rate-card estimates
sum to $0.8899796; this is an estimate, not provider-reported billed cost.
Cleanup passed. Root inspected the final task screenshot and read-only case
document/revision screenshot. The final report is
`tests/runner-e2e/results/local-2026-10-19T21-39-45-440Z/merged/index.html`.
The prior failed campaign remains separately recorded; no earlier result was
regraded. Dedicated native `create_case` itself has real HTTP and assembled
native-runner deterministic coverage; this live campaign starts through the
harness handoff API and qualifies seeded task documents and subsequent live
read/update/handoff/document work, not a provider-generated kickoff invocation.

### Required kickoff for native creation

The user's subsequent correction supersedes the optional kickoff contract above:
native `create_case` requires a complete `kickoff` (destination agent, phase and
instructions). Missing, null or partial kickoff is invalid before any writes.
Every accepted call uses the principal-idempotent handoff service to create the
case, its first ordinary task, optional initial task documents and delivery
intent atomically. There is no native passive-creation branch or run-scoped
creation receipt. The newly added `createOnly` REST extension is removed;
historical generic REST upsert behavior and existing passive records remain
compatible. This tightens new native creation without changing migrations,
existing data, task ownership or same-task handoff semantics.

The assembled native workflow no longer creates an extra passive case. It checks
that the provider-discovered tool requires kickoff, that only the workflow case
exists, and that the seeded brief remains readable before the first handoff.
Earlier reports remain evidence of the source version they exercised, not proof
of this subsequent tightening.

Qualification passed for the required-kickoff change: 118 runner contract tests,
2,131 tests across native authenticated HTTP, API catalog, ordinary case routes
and real-database handoffs, plus the assembled native workflow (1/1, 47.76
seconds including setup). Invalid kickoff leaves the case/task/comment/document/
wake/run snapshots unchanged. Valid kickoff and exact replay preserve one task,
document revision and comment; later-run replay and revoked-access denial remain
covered. Server/shared typechecks, two consecutive official runner builds at
digest `951f3accb325`, normal vendor refresh, final server build, map checks and
whitespace checks passed. No timeout changes, paid provider run, UI regression
run or full repository suite were needed for this bounded contract tightening.

### Explicit workflow document

The next user decision requires exact field `workflow_document_text` on native
`create_case` and the equivalent new-case branch of
`POST /api/companies/:companyId/case-handoffs`. The harness persists its exact
nonblank text as the primary task's ordinary Markdown document `workflow`, title
`Workflow`, before delivery. Creation, initial document revisions, attribution,
audit, comment and durable wake intent remain one transaction. Workflow text and
up to 20 additional `initialDocuments` share a 200,000-character body limit;
the normalized workflow key is reserved against duplicate optional seeds.

Every new-case API branch requires the text, including binding an existing task.
Binding additionally requires ordinary task mutation authority and uses
create-only revision semantics: an existing workflow key conflicts rather than
being overwritten. Starting a newly created primary task for an older passive
case also requires text. Later primary-task transfers reject the field; normal
document revision tools own edits. Existing-case binding keeps its historical
behavior, and there is no migration or inferred workflow for existing tasks.
Principal-scoped receipt fingerprints include the text; identical replay cannot
duplicate the workflow revision and changed text conflicts. OpenAPI 3.0 represents
new-case, existing-case and terminal requests as three derived strict branches so
creation requiredness is discoverable as well as enforced.

The authorized primary workflow reference is ordered before the bounded document
budget, including when 20 other documents precede it alphabetically. Agent
execution guidance tells the recipient to read ordinary key `workflow` before
phase/routing decisions. Its body is not injected into every prompt. The native
assembled fixture now reads that persisted document and the initial brief before
the first transfer and checks that the workflow body was not duplicated in its
bootstrap input. Process-adapter and both Product E2E fixtures supply the field;
old recorded campaigns remain evidence of their original versions.

Recommended authoring is prose plus an optional fenced Mermaid
`stateDiagram-v2` map with stable phase IDs. Prose owns actual agent IDs, expected
outputs/evidence, transition conditions, correction limits, human wait/resume
rules and completion gates. The diagram is advisory; neither its labels nor
the stored document become executable guards or privileged instructions. The
existing Markdown renderer already supports Mermaid. No graph parser, new
workflow service, stage registry or state-machine enforcement is added. Mermaid
syntax: <https://mermaid.js.org/syntax/stateDiagram.html>. DOT remains a general
graph language (<https://graphviz.org/doc/info/lang.html>); formal executable
statecharts such as SCXML (<https://www.w3.org/TR/scxml/>) are a separate future
decision rather than a dependency for this feature.

The first assembled run after this addition passed the legacy process test but
failed the native fixture's explicit no-body-in-bootstrap assertion. The failure
is preserved at `/private/tmp/workflow-document-assembled-tests.log`: generic
fresh-session history restoration excerpted all ordinary task documents,
including the new workflow document, independently of the metadata-only case
projection. This is an additional prompt assembly path, not a failed write or a
lost handoff. Workflow document history now needs reference-only projection there
as well; ordinary plan and other document history excerpts remain unchanged.

That path now selects only workflow revision identity, guidance and an
authenticated read path in SQL; it never fetches the workflow body into the
fresh-history packet. Other document excerpts, limits, time boundaries,
redaction/trust and cached-loader behavior stay in place. Seven real-database
session-history tests passed, including full fresh/bootstrap and failed-resume
envelope checks, successful resume omission, plan excerpt preservation and
workflow-body canary absence. The unchanged assembled native assertion then
passed (1/1, 51.15 seconds including setup): it read the workflow and brief through
ordinary tools, transferred the same task, resumed the returning agent and
closed the task/case normally. The earlier combined run's legacy test passed;
its native failure remains separately preserved rather than regraded.

The rest of this slice passed 80 shared/service/REST tests, 2,069 API/OpenAPI
tests, 10 native HTTP/database tests, 119 runner contract tests, 28 case context
tests and 154 credential-free Product E2E support tests. Exact-text database
coverage includes CRLF, leading/trailing whitespace and literal backslash-n.
Server/shared and Product E2E typechecks passed. Two consecutive official runner
builds and normal vendor refresh passed at digest `906c3e56e440`, with evaluation
rows/aliases preserved; the final server build passed after the history fix.
Map/whitespace checks passed. No additional paid provider campaign, UI/browser
journey or full repository test suite was run for this contract addition; the
earlier live report does not qualify the new required field.

### Workflow authoring guidance

The user clarified that creation/API guidance should recommend both a Mermaid
`stateDiagram-v2` map and prose describing the transitions, not a diagram alone.
The field schema description, native create/handoff descriptions, execution
prompt, OpenAPI endpoint, case skill guide and product/development references
now use that paired recommendation. Named diagram outcomes are defined in prose
with triggers/conditions, evidence or outputs, destination agents, human
wait/resume behavior, and bounded correction/retry/escalation rules. State IDs
match phase names. Native and REST examples include both representations, and
the guide provides a transition-definition table. This is authoring guidance;
it introduces no format parser, validation rule or server transition enforcement.

Verification for this documentation/prompt-only follow-up passed: all eight JSON
guide examples parse, 2,069 API/OpenAPI tests and 119 existing runner contract
tests pass, official generation preserves all 106 evaluation rows and 42 legacy
aliases, the final runner build records digest `0a9988610a7e`, and normal vendor
refresh reuses that build. Map and whitespace checks passed. No provider run or
full repository suite was repeated for wording and example changes.
