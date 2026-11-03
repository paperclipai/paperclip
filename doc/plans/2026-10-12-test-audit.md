# Test audit: remove redundant proof and repeated fixtures

Date: 2026-10-12
Baseline: `fb21a3f30a`
Reference: [OpenClaw test audit](https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/SKILL.md)

The combined cleanup removes **11,976 net test/support lines, 41 unused
production lines, and 1,073 registered cases**. Four obsolete ACPX
characterization files and the old Codex driver monolith are retired. Unique
contracts remain in their current owners. The latest round passes all 1,421
affected/sibling cases, with caught mutations and restored passing controls.
Workspace typecheck and build pass. The previous round's completed owner and
chat proof is recorded separately below. This is a reviewed subset of the
repository, not an exhaustive review or a complete default-suite run.

## PR delivery verification

The cleanup is published in [PR #15978](https://github.com/paperclipai/paperclip/pull/15978).
The three cleanup commits rebased onto `914b70572c` without changing their
patches. At code revision `454e3a91ff`, fresh `pnpm -r typecheck` and
`pnpm build` pass.

The local `pnpm test:run` started at that code revision. During its first
general-server invocation, one unchanged tool-access case timed out at
15,035ms: `rejects unavailable Workspace gmail.read (other profile advertised:
true)`. The invocation was stopped after the reported failure and exited 130.
It did not complete the 882 general-server files or reach the remaining
workspace and 158 serialized suites. **There is no full local default-suite
pass.** The timing discrepancy remains unresolved; earlier passes alone do
not establish its cause.

Commit `37eb57418b` only corrects a coverage-guide link to the retained HTTP
route suite. It arrived during the local default invocation, so that run is
not an immutable run of the later head, although its executable sources are
unchanged. The complete tool-access owner then runs at immutable
`37eb57418b` and passes all **419 cases**, including the timed-out matrix row,
with its existing assertions, fixtures and timeout. UI token gates also pass.
No test was skipped, removed or given a longer budget in response to the failure.

At `37eb57418b`, all remote CI and security checks pass, Greptile completes a
fresh **5/5** review, and there are zero unresolved review threads. The review
fix and this delivery record change Markdown only. Check the PR for the final
head and its required CI/review results; the local failure remains disclosed
in the PR verification section.

## Second expansion

Baseline: `8538e024d7`. Refreshed `origin/master` remains at `fb21a3f30a`.
Three auditors nominated owner batches; original-source and proposal SHA-256
guards were checked before cutover. This round changes tests, one test-gate
file selector, documentation, and scoped test ownership guidance. It changes
zero application source lines.

| Owner batch | Net test/support lines removed | Net registered cases removed |
| --- | ---: | ---: |
| Codex monolith retirement and test-gate selector | 3,780 | 64 |
| Sandbox/SSH execution target fixtures | 976 | 0 |
| Tool request/audit and heartbeat recovery consolidation | 367 | 4 |
| Issue workspace inheritance duplicates | 175 | 2 |
| **New round** | **5,298** | **70** |
| Earlier rounds | 6,678 | 1,003 |
| **Combined** | **11,976** | **1,073** |

These figures exclude Markdown. The Codex row contains 3,779 test lines and
one removed prerequisite-selector line. The earlier 41 application lines
were the unused WorkspaceRuntimeControls compatibility path; no additional
application code was removed in this round. No measured speedup is claimed.

### New retired proof and keepers

- Codex: `06f8773097` (#12371) split the driver tests but retained the
  4,153-line monolith. Its 70 declarations have 56 exact keepers, four
  evolved stronger keepers, and ten unique migrations. All parameter rows
  survive. Move tool refresh to recovery; continuation/effort/controls/goals
  to context-control; direct-chat tools and unknown outcomes to
  semantic-results. Preserve exact host-HOME equality as well as descendant
  denial, the -32004 goal-policy denial and exact availability event, and
  stronger diff/path and rejected/missing-result contracts. The monolith's
  76 registered cases become 12 migrated rows; the nine-file baseline has
  214 cases and the eight retained owners have 150.
- Test-gate routing: remove only SH-1's stale monolith filename. Its
  existing lifecycle keeper still proves additive instructions. Required
  patterns, source-digest receipts, other prerequisites and grading stay.
  Update four docs to reachable suite filters/owners. The runner package
  has its own Vitest config and is not in the root project list.
- Adapter fixtures: consolidate fresh roots/workspaces, repeated sandbox
  targets, bridge defaults and SSH targets. Expand the actual new helpers
  with their actual arguments/defaults and compare the entire executable
  AST to the committed originals. Every case, all 523 expectation statements,
  custom runner, body limit, timeout, callback, await and cleanup remains.
  Helpers allocate fresh objects/runners; all 41 converted bridge calls
  resolve target.remoteCwd to the original local remoteCwd expression.
- Tool requests: combine two audit-only cases with their exact same
  behavioral request/actor/policy owners. Move both complete activity and
  dedicated-audit assertion blocks. Preserve the missing-ID HTTP 404 in
  the existing live lifecycle. Repair the misleading non-test-origin
  negative, whose random missing ID never reached the origin guard, using
  the real persisted agent-owned request in the connected-MCP gateway case.
  Its company/connection/agent/run/issue preconditions reach the intended guard.
- Heartbeat: combine the weaker no-state accepted-plan recovery case with
  the dropped-accept-time-wake keeper. Carry every full-context/retry
  assertion. Consolidate only identical DB seed rows in five retained
  siblings; retain historical-run, answered-question, board authority and
  post-resolution timing scenarios.
- Issues: remove the second exact inheritance and explicit-override
  declarations. Both groups initialize the same real DB/service/schema and
  per-case experimental inputs. Keep every unique generic-project,
  cross-project, source-inheritance, update and runtime-config case.

### Second expansion preservation and validation

Independent reviews cover all four boundary groups. They found no remaining
preservation blockers. Codex review independently compares all 70 mappings:
66 callback/table/budget ASTs are identical under the one workspace alias,
including the ten migrations; four evolved keepers preserve/strengthen the
original contracts. Eight shared helpers match; the fake transport's existing
optional providerIdentity is absent in these cases. The existing disposable,
canonical workspace preserves cwd identity and containment tests.

Adapter helper expansion, issue full-file comparison after the two exact
deletions, server audit-block comparison and recovery helper expansion retain
all surrounding executable statements. No generated expectation, fake owner
receipt, broad skip or longer timeout replaces behavioral proof.

- Baseline: **1,459 cases pass** across all nominated complete files and the
  stock-harness gate test. The initial sandboxed attempt hit localhost
  `listen EPERM` and consequent skips; unrestricted fixture runs pass every case.
- Candidate: **1,211 server/adapter cases, 182 Codex/transport/console cases,
  and 28 stock-harness cases pass**, zero failed/skipped cases. The 182 include
  all 150 retained Codex/diff owners plus 32 transport/console siblings.
- Mutation: bypass only getTestCallStatus's origin clause. The real persisted
  request resolves and the new rejection assertion fails. Lookup/company/
  connection preconditions remain valid. Restore source byte for byte; control
  passes.
- Mutation: misclassify Codex goal policy denial as unsupported. The retained
  real availability-event assertion fails. Restore source byte for byte;
  control passes.
- Workspace `pnpm -r typecheck`, `pnpm build`, runner E2E-support typecheck,
  and `git diff --check` pass. No UI source changed in this round.
- The full default repository suite remains unverified; this is complete
  affected-owner/sibling proof. A full default run is still required before
  claiming a full local pass. These commits were local at the end of that
  round; later PR verification is recorded above.

### Retained second-round nominees

Keep native-session-runtime, runnerd transport, ACPX translation and browser
model suites: they exercise distinct lifecycle, authentication, protocol or
separate implementation owners. Keep sandbox queue versus real HTTP2 layers,
credential/stream/order guards, and unrelated tool/company/security cases.
No additional full-layer retirement was justified in those boundaries.

### Codex declaration ledger

Each exact case name identifies its protected contract; callback/table preservation was checked against the committed baseline. D deletes redundant old proof; C moves or consolidates it.

| Old line / exact case | Mark | Keeper | Evidence |
| --- | --- | --- | --- |
| 330: refreshes authorized tools on resume without replacing the provider thread | C move | `codex-app-server-driver.recovery.test.ts:1305` | identical body/table under cwd alias |
| 433: parses a complete Codex turn diff snapshot with bounded file statistics | D | `codex-turn-diff.test.ts:17` | identical body/table under cwd alias |
| 466: bounds aggregate Codex diffs and rejects unsafe workspace paths | C stronger keeper | `codex-turn-diff.test.ts:50` | explicit superset/migration above |
| 496: persists process ownership before sending provider requests | D | `codex-app-server-driver.lifecycle.test.ts:265` | identical body/table under cwd alias |
| 533: sends direct chat as plain text and permits a follow-up turn | D | `codex-app-server-driver.lifecycle.test.ts:417` | identical body/table under cwd alias |
| 579: forwards the persisted native model to the runner transport | D | `codex-app-server-driver.lifecycle.test.ts:463` | identical body/table under cwd alias |
| 600: adds Paperclip developer instructions without replacing the Codex base and enables selected skills | D | `codex-app-server-driver.lifecycle.test.ts:486` | identical body/table under cwd alias |
| 630: passes the common typed-event contract and reports one provider turn terminal | D | `codex-app-server-driver.lifecycle.test.ts:574` | identical body/table under cwd alias |
| 845: admits a strictly bound semantic result from the durable runner | D | `codex-app-server-driver.events.test.ts:47` | identical body/table under cwd alias |
| 879: correlates rehydrated notifications with the final canonical PRP event ids | D | `codex-app-server-driver.events.test.ts:81` | identical body/table under cwd alias |
| 935: maps canonical workspace snapshots with monotonic revisions and one terminal diff | D | `codex-app-server-driver.events.test.ts:137` | identical body/table under cwd alias |
| 1052: finalizes an authoritative empty workspace snapshot when a turn is interrupted | D | `codex-app-server-driver.events.test.ts:254` | identical body/table under cwd alias |
| 1095: accepts a thread usage snapshot replayed before a resumed turn starts | D | `codex-app-server-driver.events.test.ts:319` | identical body/table under cwd alias |
| 1129: normalizes provider message and reasoning phases onto every streamed item event | D | `codex-app-server-driver.events.test.ts:353` | identical body/table under cwd alias |
| 1264: captures an exact skillless model/environment snapshot with credentials absent | D | `codex-app-server-driver.context-control.test.ts:82` | identical body/table under cwd alias |
| 1356: pins approval policy %s for both thread start and resume | D | `codex-app-server-driver.context-control.test.ts:174` | identical body/table under cwd alias |
| 1383: requires trusted continuation metadata before omitting task context (%s) | C move | `codex-app-server-driver.context-control.test.ts:692` | identical body/table under cwd alias |
| 1402: allows eval fixtures to opt out of Codex collaboration instructions | D | `codex-app-server-driver.context-control.test.ts:201` | identical body/table under cwd alias |
| 1423: negotiates genuine plan mode with collaboration instructions and read-only workspace access | D | `codex-app-server-driver.context-control.test.ts:222` | identical body/table under cwd alias |
| 1466: sends the selected reasoning effort with the Codex turn | C move | `codex-app-server-driver.context-control.test.ts:711` | identical body/table under cwd alias |
| 1478: fails closed when the installed app-server does not confirm plan mode | D | `codex-app-server-driver.context-control.test.ts:265` | identical body/table under cwd alias |
| 1492: refuses to turn host credential roots into model-writable workspaces | C stronger keeper | `codex-app-server-driver.context-control.test.ts:279` | explicit superset/migration above |
| 1528: uses negotiated ACP controls through the Codex transport facade | C move | `codex-app-server-driver.context-control.test.ts:723` | identical body/table under cwd alias |
| 1549: keeps native follow-up disabled for the Codex app-server driver | C move | `codex-app-server-driver.context-control.test.ts:744` | identical body/table under cwd alias |
| 1560: steers and interrupts an active turn without replacing the session | D | `codex-app-server-driver.context-control.test.ts:315` | identical body/table under cwd alias |
| 1590: loads the deterministic Live console wire fixture | D | `codex-app-server-driver.context-control.test.ts:345` | identical body/table under cwd alias |
| 1612: holds browser-resolved upstream requests and returns the exact fixture responses | D | `codex-app-server-driver.context-control.test.ts:367` | identical body/table under cwd alias |
| 1673: acknowledges same-turn steering and rejects stale or child steering | D | `codex-app-server-driver.context-control.test.ts:428` | identical body/table under cwd alias |
| 1792: queues an interrupt before turn identity and reports a terminal race precisely | D | `codex-app-server-driver.context-control.test.ts:547` | identical body/table under cwd alias |
| 1827: maps all goal operations and advertises an exact unsupported state | C stronger keeper | `codex-app-server-driver.context-control.test.ts:582` | explicit superset/migration above |
| 1907: keeps goal support advertised when the probe fails transiently | D | `codex-app-server-driver.context-control.test.ts:662` | identical body/table under cwd alias |
| 1937: preserves an inactive goal status while editing its objective | C move | `codex-app-server-driver.context-control.test.ts:755` | identical body/table under cwd alias |
| 1964: rolls back only a definitely rejected idle goal autostart | C move | `codex-app-server-driver.context-control.test.ts:782` | identical body/table under cwd alias |
| 2014: preserves a provider-neutral goal action subset through the Codex transport facade | C move | `codex-app-server-driver.context-control.test.ts:832` | identical body/table under cwd alias |
| 2059: validates runtime request resolutions against the kind of request they answer | D | `codex-app-server-driver.runtime-requests.test.ts:47` | identical body/table under cwd alias |
| 2176: replays the DOT-185 requestUserInput shape as one canonical three-question request | D | `codex-app-server-driver.runtime-requests.test.ts:164` | identical body/table under cwd alias |
| 2282: rejects an explicit malformed Codex form without falling back to v1 | D | `codex-app-server-driver.runtime-requests.test.ts:317` | identical body/table under cwd alias |
| 2324: emits one canonical outcome payload for every terminal runtime request fact | D | `codex-app-server-driver.runtime-requests.test.ts:359` | identical body/table under cwd alias |
| 2410: expires a canonical input with its full question set when the provider transport is lost | D | `codex-app-server-driver.runtime-requests.test.ts:445` | identical body/table under cwd alias |
| 2469: hands a live canonical input off exactly once when the durable window expires | D | `codex-app-server-driver.runtime-requests.test.ts:504` | identical body/table under cwd alias |
| 2551: exposes and dispatches only explicit chat tools across fresh and resumed direct chat | C move | `codex-app-server-driver.semantic-results.test.ts:866` | identical body/table under cwd alias |
| 2683: lets an answer claimed before expiry win the terminal-event race | D | `codex-app-server-driver.runtime-requests.test.ts:644` | identical body/table under cwd alias |
| 2758: redacts browser-visible request details and diagnostics from the fixture markers | D | `codex-app-server-driver.runtime-requests.test.ts:719` | identical body/table under cwd alias |
| 2796: makes duplicate semantic completion idempotent and rejects changed payloads | D | `codex-app-server-driver.semantic-results.test.ts:151` | identical body/table under cwd alias |
| 2873: accepts a normalized runnerd echo of a tool-committed semantic result | D | `codex-app-server-driver.semantic-results.test.ts:226` | identical body/table under cwd alias |
| 2928: advertises and dispatches run-authorized control-plane tools | D | `codex-app-server-driver.semantic-results.test.ts:288` | identical body/table under cwd alias |
| 2988: preserves the dynamic tool outcome boundary (%s) | C move | `codex-app-server-driver.semantic-results.test.ts:998` | identical body/table under cwd alias |
| 3011: fails closed when an agent message changes a tool-committed result | D | `codex-app-server-driver.semantic-results.test.ts:348` | identical body/table under cwd alias |
| 3058: rejects a tool result that changes an agent-message commitment | D | `codex-app-server-driver.semantic-results.test.ts:450` | identical body/table under cwd alias |
| 3109: treats a canonically identical cross-channel result as a no-op | D | `codex-app-server-driver.semantic-results.test.ts:501` | identical body/table under cwd alias |
| 3153: fails closed when a live terminal embeds a changed semantic result | D | `codex-app-server-driver.semantic-results.test.ts:545` | identical body/table under cwd alias |
| 3205: rejects a semantic result for $label without committing it | D | `codex-app-server-driver.semantic-results.test.ts:597` | identical body/table under cwd alias |
| 3244: rejects pre-turn, cross-thread, and post-terminal notifications | D | `codex-app-server-driver.semantic-results.test.ts:636` | identical body/table under cwd alias |
| 3328: rejects duplicate and conflicting terminal facts | D | `codex-app-server-driver.semantic-results.test.ts:720` | identical body/table under cwd alias |
| 3362: rejects oversized semantic results without retaining provider payloads | D | `codex-app-server-driver.semantic-results.test.ts:754` | identical body/table under cwd alias |
| 3404: normalizes finish and block tools into one canonical result contract | D | `codex-app-server-driver.semantic-results.test.ts:796` | identical body/table under cwd alias |
| 3475: resumes and reconciles the exact provider thread after transport loss | D | `codex-app-server-driver.recovery.test.ts:297` | identical body/table under cwd alias |
| 3507: ignores an old terminal turn when the persisted active turn is still running | D | `codex-app-server-driver.recovery.test.ts:365` | identical body/table under cwd alias |
| 3548: preserves proposal idempotency and rejects a changed result after transport loss | D | `codex-app-server-driver.recovery.test.ts:406` | identical body/table under cwd alias |
| 3632: rejects changed terminal result content discovered during recovery | D | `codex-app-server-driver.recovery.test.ts:490` | identical body/table under cwd alias |
| 3703: does not re-emit an already observed terminal after recovery | D | `codex-app-server-driver.recovery.test.ts:561` | identical body/table under cwd alias |
| 3758: fails recovery explicitly when the persisted active turn is missing or replaced | D | `codex-app-server-driver.recovery.test.ts:1186` | identical body/table under cwd alias |
| 3799: reconciles a turn completed during transport loss without replacing either session identity | D | `codex-app-server-driver.recovery.test.ts:1227` | identical body/table under cwd alias |
| 3877: degrades unsupported operations with explicit redacted diagnostics | D | `codex-app-server-driver.conformance.test.ts:47` | identical body/table under cwd alias |
| 3912: rejects proposals that do not match the exact task envelope | D | `codex-app-server-driver.conformance.test.ts:82` | identical body/table under cwd alias |
| 3947: keeps a completed runtime successful for an accepted %s advisory proposal | D | `codex-app-server-driver.conformance.test.ts:117` | identical body/table under cwd alias |
| 4001: records rejected and missing proposals as recovery evidence instead of review status | C stronger keeper | `codex-app-server-driver.conformance.test.ts:171` | explicit superset/migration above |
| 4033: preserves four independent stable identities under controller ownership | D | `codex-app-server-driver.conformance.test.ts:210` | identical body/table under cwd alias |
| 4054: validates persisted identity, uniqueness, terminals, and line bounds before replay | D | `codex-app-server-driver.conformance.test.ts:231` | identical body/table under cwd alias |
| 4103: degrades declared unsupported capabilities without Codex-specific core branches | D | `codex-app-server-driver.conformance.test.ts:280` | identical body/table under cwd alias |

## Aggressive follow-up

The follow-up baseline is `3951d69f9b`, which contains the small first pass.
`origin/master` was refreshed and remained at `fb21a3f30a`. Three read-only
auditors examined adapter lifecycle, native execution, and UI ownership.
Proposals were prepared outside the checkout while baseline tests ran, then
applied with original-source SHA-256 guards.

| Owner batch | Net test/support lines removed | Production lines removed | Net registered cases removed |
| --- | ---: | ---: | ---: |
| ACPX characterization layer | 3,283 | 0 | 44 |
| Chat database read fixtures | 1,612 | 0 | 0 |
| Native executor, resume, and runner API | 802 | 0 | 943 |
| UI fixture consolidation and obsolete compatibility | 698 | 41 | 7 |
| Exact workspace/Daytona duplicate cases | 137 | 0 | 2 |
| Initial pass | 146 | 0 | 7 |
| **Total** | **6,678** | **41** | **1,003** |

These figures exclude documentation. Savings are measured from the Git diff,
not formatting estimates. The case counts include migrated/table-expanded
keepers, not just deleted declarations. No wall-time speedup is attributed to
the change: baseline and candidate runs had different cache and machine load.

### Retired layers and their keepers

- ACPX: remove startup, turn, settlement, and composed-run characterization
  suites (3,643 gross lines). They copied the engine harness for #11461's
  refactor; #11576 completed the coordinator extraction. The current
  `execute.test.ts`, fault matrix, sequence, cancellation, session-store, and
  workspace teardown suites own their remaining proof. Unique Stop-phase
  regressions from #14990 remain, with actual callback/gate observations.
  Preserve bridge credential isolation, current prompt/turn inputs, fingerprint
  dimensions, retry order, close/cancel policy, bridge-stop before sync-back,
  lease release, and native restore/last-finalize assertions in those keepers.
- Chat: replace 607 repeated real database query chains with 22 typed,
  file-local query owners. Every table, column, parameter, caller await,
  ordering, limit, polling loop, action, and assertion remains. Independent
  expansion of the helpers produces a normalized AST identical to the entire
  original program. All 1,237 integration cases execute before and after.
- Native: consolidate repeated scoped-runtime fixtures while retaining every
  executor declaration and parameter row, including 1,010 complete assertion
  chains. Replace six copied historical catalog constructors with independently
  checked immutable digests in the existing resume table. Restore the valid
  context before testing changed agent identity so that the negative cannot
  pass through an earlier, unrelated instruction mismatch.
- Runner API: remove the second identical REST-route matrix. Baseline
  collection executes 943 rows twice; the keeper executes each same row once.
  The full file changes from 1,994 to 1,051 passing cases. No catalog entries
  or public route/actor/response contract are removed.
- UI: remove five exact duplicate cases and two tests of an internal legacy
  workspace API with no production callers or published source export. Both
  shipped workspace pages use the retained `sections` interface. Consolidate
  Secrets rendering, fresh Daytona capabilities, and four literal runtime
  status rows without changing their actions, waits, or outcomes. Two AWS
  error negatives now actually receive the sensitive provider details they
  assert are absent.
- Workspace/Daytona: remove a second byte-equivalent worktree dependency case
  and an overlapping-execute case whose body duplicated the retained lease
  tombstone test. All other provisioning and teardown guards remain.

### Preservation review and final proof

Independent reviewers checked each of the four large owner proposals against
its original tests and production callers. Review caught and repaired lost
existing-file overwrite proof and a prompt guard that could accept
`String(undefined)`. Both fingerprints in the dimension matrix and the exact
session-key keeper now also require nonempty strings. No remaining preservation
blocker was found.

Three additional production mutations were caught at assertions: dropping the
runtime prompt, skipping existing-file writes during native restore, and
spreading unsafe secret-provider details into the UI. Every production file was
restored byte for byte. The two AWS negative cases fail on the unsafe-details
mutation. All four focused controls pass after restoration. The earlier HTTP
mutation proof remains below.

- Complete affected owners and siblings: **22 files, 2,817 cases pass**.
- Complete chat integration: **1,237 cases pass**, both baseline and candidate.
- ACPX baseline: 335 cases pass; native/UI baseline: 939 pass; runner API
  baseline: 1,994 pass. Additional workspace/Daytona/UI baseline records 508
  passes and 10 pending cases with a failed workspace file but no failed case.
  That baseline inconsistency is not claimed repaired; the complete retained
  workspace file subsequently passes all 175 cases with built prerequisites.
- `pnpm -r typecheck`, `pnpm build`, token gates, and diff whitespace checks pass.
- The full default repository suite remains unverified. The completed tests
  above are full files at the affected owners; they are not a claim that all
  repository tests ran. A full default run remains required for a PR-ready
  handoff.

## Initial pass evidence

### Scope and findings

This is a repository inventory and a small evidence-backed cleanup, not a review
of every test. The baseline has 2,816 tracked `*.test.*` / `*.spec.*` files:
1,038 server, 725 UI, 697 packages, 216 test harnesses, 66 CLI, 50 scripts,
21 GitHub tooling, and 3 skill tooling files. These include opt-in suites;
the count does not describe the default Vitest run alone.

A text scan found 382 files that combine file reads with containment/matching
assertions: 156 packages, 133 server, 42 harnesses, 18 UI, 13 CLI, 13 scripts,
6 GitHub tooling, and 1 skill tooling file. The scan also matches fixture reads
and executable checks. **382 is a review queue, not a deletion estimate.**

The useful question is which independent regression a test catches that the
retained owner proof misses. File reads, snapshots, mocks, and slow tests are
not sufficient reasons to remove a test.

### Applied decisions

| Candidate | Decision and retained proof |
| --- | --- |
| `server/src/__tests__/issue-interactions-read-only-contract.test.ts`: route source check | Remove the file after adding terminal-expiry and activity-write assertions to the existing real HTTP read-path test in `issue-thread-interaction-routes.test.ts`. Check both `in_review` and `done`, the JSON response, listing, and absence of recovery. |
| Same file: two whitespace rows, three forbidden-name rows, two missing-boundary rows | Remove all seven synthetic cases. They test a local regex/assertion helper against hand-written route strings, not production behavior. Removing the helper removes their purpose. |
| Retry cases in `ui/src/api/chatEndpoints.test.ts` and `agents.test.ts` | Consolidate under `agents.test.ts`, the production API owner. Preserve the exact company-scoped request, ordinary and durable receipts, distinct stopped-successor errors, deferred dispatch, legacy receipts, both skipped-wake forms, and single-dispatch checks. |
| Slack manifest replay in `ui/src/pages/apps/chat/chat-ui-contract.test.ts` | Remove duplicate scope/event assertions already pinned by the shared owner snapshots. Move the unique agent-view, bot presence, and app-home assertions to the existing shared manifest test. Keep the UI's manifest integration checks. |
| Same UI file: sanitizer implementation substrings | Remove the checks for `replaceAll` and `encodeURIComponent`. Keep the UI integration assertions and `chat-setup-error.test.ts`, which exercises raw, escaped, encoded, and malformed UTF-16 secrets. |
| Same UI file: v8 wireframe generator/import strings | Remove the design-plan implementation checks. Keep the shipped GitHub setup assertions, wizard behavior suite, and PEM file/late-read tests. Design generator version names are not a product contract. |

The source-only route test originated in #10414; its synthetic parser cases
arrived in #13038, alongside the real HTTP test. The UI retry coverage came from
#13038 and #13765. The current chat source-check owner was last changed in
#15416. None of the removed support code has a production caller.

Change size before this report: **146 net test lines removed**, one test file
retired, seven fewer executed cases across the affected route suites, and zero
production lines changed. No runtime speedup is claimed: cold transforms,
prerequisite builds, and a baseline timeout prevent a fair wall-time comparison.

### Preservation evidence

- UI baseline: 48 cases pass across the two API files, chat UI source contract,
  chooser routing, and setup-error suite. The shared manifest has four cases.
- After cleanup: those six UI/shared suites pass, 52 cases total.
- Route baseline: the eight source-check cases pass; 84 of 85 HTTP cases pass.
  The unchanged standard-work plan-confirmation case times out at 15 seconds
  during the full file run. Isolating it with the original read-path case passes
  both. This does not establish a flake repair; its test and timeout remain intact.
- Three temporary mutations add historical expiry, terminal expiry, or an
  activity write to the production GET handler. Each makes the retained HTTP
  test fail at its side-effect assertion. Production source is restored byte
  for byte after every mutation, including failure cleanup.
- UI token gates and `git diff --check` pass.

- Final complete HTTP route file: all 86 cases pass. Together with the 52
  UI/shared cases, focused validation passes 138 cases.
- `pnpm -r typecheck` and `pnpm build` pass.
- `pnpm test:run` was started, then interrupted after about five minutes while
  still running its first general-server file, the 75,178-line chat integration
  suite. It exited 130; there is no full-suite pass or failure conclusion.
  The default runner has 158 separately serialized suites after its general
  lanes. A complete run remains a prerequisite for claiming a PR-ready handoff.

### Next review boundaries

1. Remaining `chat-ui-contract.test.ts` assertions: exact retry call syntax,
   tabs, lifecycle handlers, and provider fields. Replace them only after
   rendered tests exercise the selected run, navigation, error, or credential
   outcome. Provider guidance and permission bytes need independent proof.
2. Component-only helper exports: `shouldRenderComposerHandoffPreview`,
   `replaceResolvedInteraction`, and model-transition helpers. Their direct
   tests currently protect distinct behavior. The existing rendered suites do
   not cover every assertion, so deletion is not yet justified.
3. Server source guards: compare each with its route/service owner before
   pruning. Authentication ordering and company boundaries deserve particular
   care; a source guard can protect routes missing a behavioral negative case.

Retain protocol-schema cross-checks, package/build metadata, migration replay,
dependency singleton checks, provider permission snapshots, and theme contrast
tests. They compare independent contracts or outcomes. The telemetry README
guard is also retained; changing that path requires its own strict review.

For another batch, pin a fresh baseline, assign one production boundary,
record every deletion's keeper first, and prove the keeper catches the relevant
mutation. Do not optimize for test counts or remove baseline failures for green.
