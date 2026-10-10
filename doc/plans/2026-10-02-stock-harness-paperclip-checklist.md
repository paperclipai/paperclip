# Stock harness, with Paperclip: working checklist

Created: 2026-10-02. Status refreshed locally: 2026-10-06.

Native Codex base preservation (#14920), the tiny default manual/common legacy
prompts (#14948), general hiring templates (#14985), native completion tool
guidance (#14961), evaluator accounting repairs (#15007), and native completion
constraint/final-answer corrections (#15151) are merged. Dotta confirmed the
latest merge; GitHub records #15151 merged on 2026-10-05. The detailed sections
below retain historical stages and failures; this status supersedes their old
draft/pending descriptions. The saved master checklist had lagged behind the
implementation and evidence notes and is reconciled here. Native-tool measurement
(#15218) and the smaller planning skills (#15296) are also merged; the
2026-10-06 entry below records their scope and the next repair.

Remaining work: deferred legacy carriers (2.2), uncommon native fixed-prompt
procedures beyond the completed completion slice (2.3), specialized agent
contracts (3.4), repository context (4), broader runtime bookkeeping (5), and
the full harness/configuration audit (6). Completed evals qualify their bounded
cases, not general coding quality or every configuration. The prepared final
#15151 PR body/eval summary was not published before the human merged it;
publication remains separate from implementation completion.

Goal: keep the agent's stock harness behavior and add only what it needs to work
with Paperclip. Apply this across legacy adapters, the new Runner, and their
configuration variants.

We will work through the numbered items one at a time with Dotta. For each item,
record the proposed behavior and Dotta's direction, make a bounded change, and
verify the affected paths before moving on. New findings get stable IDs in the
ledger below so they do not disappear into conversation history.

For every change, record its executable test/eval coverage before continuing.
Distinguish coverage setup, deterministic results, and measured live results;
configured cells alone do not qualify behavior.

**Current item: repair and qualify the native delegation handoff before further procedure reduction.**

## Agreed direction and boundaries

- Preserve vendor base instructions. Paperclip context should be additive where
  the harness supports it.
- Reduce the default hire operating manual and review every role/team template
  for reduction or removal. Prefer a tiny default, potentially one paragraph.
- Keep a minimal coordination boundary; load uncommon procedures on demand.
- Move bookkeeping into the runtime where it can own the operation reliably.
- Check capability and configuration behavior across all harness paths.
- Paperclip owns MCP configuration. Missing personal integrations are acceptable
  and intentional; restoring them is not a goal of this work.
- Configuration changes and configuration-driven session resets are acceptable.
- Preserve Paperclip authentication, assigned skills, workspace access, tool
  authorization, company boundaries, checkout, approvals, budget hard stops,
  pause/cancel behavior, audit records, and usable task/artifact delivery.
- Restore appropriate repository instruction context without accidentally
  importing unrelated host configuration or displacing Paperclip-owned MCPs.
- Decide explicitly how changed defaults affect existing agents and sessions;
  do not assume existing custom instructions should be rewritten.

## 1. Preserve the native Codex base instructions

- [x] Trace every instruction path: backend composition, TypeScript driver,
  runnerd bridge, and Rust provider; include fresh threads, resume, and recovery.
- [x] Record the chosen additive mechanism and the minimum Paperclip context it
  needs to carry. Include fallback/direct execution paths.
- [x] Remove default replacement of stock base instructions across those paths.
- [x] Verify the actual app-server request and retained session instructions,
  including resume; checking only a prompt builder is insufficient.
- [x] Verify Paperclip task context, tools, auth, assigned skills, and completion
  still work. Record applicable regressions and eval results.

Starting points: [Codex backend](../../packages/paperclip-runner/src/backends/codex-native-backend.ts),
[app-server driver](../../packages/paperclip-runner/src/drivers/codex/codex-app-server-driver-impl.ts),
[runnerd transport](../../packages/paperclip-runner/src/live/runnerd-codex-transport.ts),
[Rust provider](../../packages/paperclip-runner/runner/crates/runner-core/src/codex_provider.rs).

Decision: use additive `developerInstructions` on Codex start and resume in the
TypeScript driver, Runner Lab/eval sessions, and Rust provider. Retain existing
instruction fields for other provider facades. Keep the Paperclip fragment and
its historical option/trace names unchanged in this bounded fix.

Transition: pre-change Codex threads retain their saved replacement base prompt
and need a provider session reset. Do not reset active sessions automatically.
The separate Codex-through-ACP dependency patch remains a coverage follow-up
under item 6; this change covers the native app-server path.

Verification: 412 focused TypeScript/Rust tests, repository typecheck/build,
55 passing PR checks, and Greptile 5/5. The original full local test command
was stopped after setup failures; affected suites passed on rerun. No paid
live campaign was run, and no task-quality improvement is claimed.

## 2. Reduce the default operating manual and shared prompt layers

- [ ] Inventory what an agent actually receives: hire instructions, shared
  prompt template, wake context, runtime prompt, bootstrap, and loaded skills.
  Separate always-present text from content loaded on demand.
- [x] Agree on the tiny default: identity only, with no skill or native-tool
  pointers. The harness supplies coordination instructions.
- [x] Reduce the generic default hire `AGENTS.md` to the agreed sentence and
  update the existing creation test to expect the minimal bundle.
- [ ] Remove repeated workflow rules and stock coding/style/autonomy guidance.
- [ ] Move detailed planning, hiring, artifacts, and exceptional procedures to
  discoverable references or tools where feasible.
- [ ] Check fresh and resumed task/chat flows for instruction duplication and
  contradictory completion or waiting rules.

Starting points: [default hire instructions](../../server/src/onboarding-assets/default/AGENTS.md),
[shared adapter utilities](../../packages/adapter-utils/src/server-utils.ts),
[native runtime contract](../../packages/paperclip-runner/src/contracts/runtime-context.ts),
[Paperclip operational skill](../../skills/paperclip/SKILL.md).

Decision: Dotta confirmed the harness already handles skill and tool delivery;
the default hire manual is now only "You are an agent in a Paperclip company."
This replaces 602 words with eight. The shared loader supplies this default
across instruction-bundle-capable adapters for non-CEO hires without explicit
instructions. Existing saved bundles retain their content; CEO, first-agent,
and role/team templates remain separate work under item 3. The common
  prompt/wake reduction and legacy delivery repairs are merged in #14948;
  additional carriers and uncommon native procedures remain open. Native
  completion documentation and constraint/final-answer corrections are merged
  separately in #14961 and #15151.

Verification: the existing agent-skills route suite passed all 54 tests,
including default creation, custom bundles, and CEO/first-agent paths. The
onboarding asset suite passed all 10 tests. This initially had only deterministic
coverage. Dotta subsequently requested behavioral eval coverage for every change;
the dedicated production-default-hire suite below closes the custom QA manual
gap. Full repository typecheck/build/test were not rerun for this narrow asset
and existing-test update.

### Shared prompt follow-ups

- [x] **2.1 Reduce common legacy startup/resume instructions.** Keep
  identity and connection guidance in the shared task/chat defaults; remove the
  generic resumed-wake execution contract. Preserve current task/event data,
  specialized wake contracts, custom templates, skills, and auth.
- [ ] **2.2 Review additional legacy carriers.** Reduce Hermes local/gateway
  wrappers, review Pi system delivery, and check OpenClaw fresh-wake framing.
  Preserve transport facts and user configuration. Dotta deferred this item on
  2026-10-02 for a later revisit; it remains open.
- [ ] **2.3 Reduce native Runner instructions and constraints.** Improve
  discoverable tool documentation first, then shorten fixed guidance and
  consolidate completion rules. Verify prompt revisions, digests, and session
  compatibility across native Codex, ACPX, and OpenCode. Dotta approved the
  native tool-documentation slice on 2026-10-02 in a separate worktree. Native
  `paperclip_finish`/`paperclip_block` guidance must not leak into legacy
  completion paths, which use the operational skill and API.
- [x] **2.3 completion slice.** Improve native finish/block documentation
  (#14961), consolidate repeated completion constraints, and preserve useful
  final replies, blocker explanations and working document links (#15151).
  Native Codex, ACPX Claude and OpenCode have bounded live outcome coverage;
  scripted start/resume/continuation and compatibility checks remain distinct
  from live resume qualification.
- [ ] **2.3 remaining procedures.** Review the fixed hiring, dependencies and
  connection guidance; improve discoverable tool documentation and measure any
  further reduction. #15151 intentionally did not change the fixed prompt.
  Hiring/dependency relocation failed both corrected and readiness comparisons.
  #15218 now retains measurement and eval coverage with production unchanged;
  see [the comparison report](2026-10-05-native-procedure-guidance.md).
  Connection procedures remain a separate follow-up.
- [x] **2.3 full-catalog measurement.** PR #15218 measures all 39 supplied
  native tools and schemas with fixed instructions at start/resume/continuation.
  The rejected corrected candidate reduced the normalized standing projection by 460 bytes
  (48,781 to 48,321 in the paid context; 49,200 to 48,740 after master integration),
  not a token/cost or upstream truncation claim. The rejected readiness repair
  restored explicit delegation/review guidance and saved only 125 bytes.
  Its larger unqualified controller repair increased the full projection.
  Final #15218 restores production to baseline: 49,200 bytes, identical across
  all 36 normalized components of nine scripted deliveries and the MCP catalog.
- [ ] **2.3 hiring/dependency behavior qualification.** The original six-pair
  campaign exposed three new overall failures, including Claude omitting
  dependency recording and finalization. Preserve original grades and control
  bugs. Corrected v7 candidate and a baseline with matching credential/budget
  repairs completed: baseline 5/6 PASS, candidate 3/6 PASS; two new failures,
  zero new passes, three unchanged passes and one unchanged failure. Codex's
  parent remained blocked after the replacement deliverable. OpenCode hiring
  exceeded the deadline before the revised delivery settled. Both OpenCode
  delegation variants lacked parent review of the final child revision. Two
  interrupted candidate cells had one bounded recovery each; incomplete
  original accounting is retained. No rerolls of these completed source pairs.
  After the human requested readiness fixes, candidate
  `aba7ec219b588de02cf323b4ebca559a105e6d01` restores assigned-worker revisions
  and latest-child review, returns actual dependency readiness, and separates
  cancelled dependencies from tasks that can complete. Its 23 database-backed
  tool tests and fresh 5/5 review pass. New candidate campaign `37348723829`
  and integrated baseline `37348764875` completed with unchanged oracles and
  bounds: candidate 3 PASS / 3 FAIL; baseline 3 PASS / 2 FAIL / one setup cell
  without a behavioral grade. The five comparable pairs have two new failures,
  two new passes and one unchanged pass; one pair remains uncomparable. The
  new failures include parent completion before the latest child revision and
  OpenCode credential persistence. The Codex candidate also lacks parent
  continuation. Keep this item open. The final #15218 excludes the production
  change, retains every failure, and adds measurement and eval coverage only.
  Unqualified runtime fixes are preserved locally for separate follow-up.

### Remaining fixed-prompt audit — 2026-10-05

Read-only inspection verified the prompt, semantic catalog, shared connection
guidance, production tool authority and payload-measurement file against their
exact blobs on merged master `a386a599983519eb1d399f8b770bfccdb2a74762`.
The fixed prompt is 262 whitespace-separated words / 1,713 UTF-8 bytes: 34
general context, 123 hiring/delegation/dependencies, 98 connections and seven
finishing words. These are source-text counts, not provider token/billing data.

The hiring recipe still mandates `search_api`/`call_api`, although the available
`hire_agent` tool already creates persistent native teammates and documents
runtime inheritance/reuse. Hiring and API fallback tools share the API-tool
availability gate. Update the discovery/selection guidance to prefer an
available dedicated tool and keep configuration-specific fallback in its own
documentation; provider helper threads must remain distinct from company hires.

`create_task` documents creation but omits the assigned-worker/review boundary.
`set_dependencies` describes replacement only; preserving existing blocker IDs
and releasing the workspace are still carried by the fixed prompt. Improve
these tool contracts before removing the corresponding prompt procedure.
Connection tools already document discovery, recorded provider choices, setup
cards and yielding. Keep a small discovery trigger for explicit setup requests;
put state-specific retry/decline/continuation instructions in tool descriptions
and actual result guidance. These are reduction proposals, not implemented or
behaviorally qualified changes.

Measure the complete delivered prompt, constraints and granted tool descriptions
together. The existing scripted capture selects only core semantic tools, so it
omits these optional hiring/dependency tools and the connection tools. Moving
words into descriptions alone does not demonstrate lower total instruction load.
Keep prompt revision/digest and incompatible-session checks explicit.

Candidate coverage includes the existing Product E2E `hire-reuse`,
`delegate-feedback`, service approval/decline and connection-routing stories.
Those stories cover Codex/Claude; corresponding OpenCode qualification and exact
blocker-preservation/workspace-yield assertions still need review. Some decline
fixtures explicitly restate the no-retry rule, so they cannot alone measure its
discovery from shipped guidance. Previous completion-only passes do not qualify
these procedures. Prefer hiring as the first bounded slice, then matched
before/after outcomes with common fixture/model/auth/permission/budget controls.

### Follow-up 2.3 merged completion slice — 2026-10-05

#15151 merged as `a386a599983519eb1d399f8b770bfccdb2a74762` from final source
`16ef1a5744b23bb043a8b286e6288921da1de98f`. The shortened completion contract
now retains an explicit blocker cause/owner/action and a canonical clickable
document handoff. Runtime feedback, OpenCode acceptance/settlement and proxy
ordering corrections preserve the final provider response rather than treating
an accepted terminal tool call as sufficient delivery.

The six scoped corrective cases pass: four Codex/Claude cases measured at
`3a7349ddc60142283c394121882288f2db07b215`, and two OpenCode cases measured at
the final source. The intervening production delta is confined to OpenCode;
the shared instructions, server feedback and UI paths are byte-identical.
These are explicitly mixed-source observations, not six live runs on the final
head. Document cases open the actual saved revision and original marker from
the final reply; blocker cases retain the missing-access reason, exact owner,
unblock action and task-wide scope. Final-head CI is green and fresh review is
5/5 with all review threads resolved.

Original paired grades and every corrective failure remain preserved. Passing
totals had concealed weak blocker explanations and missing document links;
the subsequent oracle explicitly checks those behaviors. Single trials do not
prove broad equivalence, cognitive skill consumption, general coding quality,
live resume behavior, or speed/cost trends. See the
[constraint plan](2026-10-03-native-completion-consolidation.md) and
[final-answer correction history](2026-10-04-native-completion-answer-fix.md)
for the preserved setup and behavior failures; their initial hold statements
are historical and superseded by this merged status.

### Follow-up 2.1 implementation and verification

The common task and conversation defaults now share the same identity sentence
and unchanged connection guidance: 113 words each, down from 661 and 205.
Connection guidance accounts for 108 of those words. The ordinary resumed-wake
execution contract is removed (172 words), including the old opt-in used by
OpenClaw on fresh turns. `includeExecutionContract` remains accepted as a
deprecated no-op for adapter/plugin source compatibility.

Current task facts, ordered comments, work modes, approval/review state,
checkout, holds/blockers, recovery/watchdog roles, and external-chat contracts
remain in their existing owners. Skill delivery, runtime authentication,
custom `promptTemplate`, and `bootstrapPromptTemplate` mechanics are unchanged.
Hermes's own wrappers and Pi's system carrier remain follow-up 2.2; native
fixed instructions and full-turn constraints remain follow-up 2.3.

The later read-only 2.2 audit found another OpenClaw-owned HTTP identity,
checkout/status, delegation, plan-approval and task-discovery wrapper in
`buildWakeText`. Its short conversation branch is selected when optional task
Markdown is present, including on ordinary task dispatch. Existing dispatch
coverage does not assert the absence of conversation waiting language. This is
a framing concern to verify, not a measured failure. Pi already uses additive
`--append-system-prompt` delivery and suppresses the duplicate user-prompt copy;
its next step is a delivery audit with minimal changes. These findings are
deferred with 2.2 and are not implemented in PR #14948.

The new defaults apply when prompts are assembled after deployment. Existing
provider sessions can retain earlier startup instructions in their history
until reset; no active session or saved custom template is rewritten here.

Verification: 563 distinct focused tests passed across 18 suites:

- Shared prompt selection/rendering, operational-skill selection, and retained
  specialized wake contracts (130 tests).
- ACPX, Pi, OpenCode, Cursor Cloud, and Codex local execution, including
  task/chat fresh/resumed/reset/fallback delivery, custom prompts, skill
  mounting, and authentication (259 tests).
- Hermes local prompt rendering and gateway execution (41 tests).
- Claude, Gemini, Cursor local, Grok, Kimi, OpenClaw, and Claude/Codex ACP
  fallback execution (113 tests).
- Native execution input, preserving shared wake compatibility (20 tests).

`@paperclipai/adapter-utils` typecheck and build passed; `git diff --check`
passed. Full repository typecheck/build/test and live behavioral evals were not
run for this local bounded change. These checks prove prompt and runtime
mechanics, not an improvement in coding-task quality.

### Remaining shared layers inspected (2026-10-02)

The table records the initial inspection before follow-up 2.1. Word counts
cover fixed source text, not complete assembled prompts or token counts. They
exclude task data, assigned agent instructions, and skills. This inspection
establishes instruction mechanics, not a performance result.

| Layer | Delivery at initial inspection | Disposition |
| --- | --- | --- |
| Shared legacy task/chat templates | `DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE` was 661 words and the conversation template was 205, including connection guidance. Used by Claude, Codex, Cursor local/cloud, Gemini, Grok, Kimi, OpenCode, Pi, and Hermes local. | Completed in 2.1: both defaults now 113 words. Repeated procedures removed, connection guidance retained, no replacement skill pointer. |
| Generic resumed wake contract | `renderPaperclipWakePrompt` added a 172-word execution contract on ordinary resumed turns. OpenClaw requested it on fresh turns too because it has no shared template. | Completed in 2.1: generic contract removed, including legacy opt-ins. Task/event data and conditional runtime contracts retained. |
| Additional legacy carriers | Hermes local adds a 171-word identity/API/curl wrapper before the shared task template; Hermes gateway supplies its own four-rule execution contract. Pi carries shared defaults in its system extension and suppresses the wake copy when that extension owns policy. | Separate follow-up 2.2; changing the shared constants alone does not remove every wrapper. Preserve transport facts and custom configuration. |
| Native fixed prompt | The 262-word `paperclip-execution.v5` prompt carries hiring, delegation/dependencies, connection setup, and finalization guidance across native Codex, ACPX, and OpenCode backends. | Keep one short native completion/dependency contract. Relocate uncommon procedures to the relevant tool documentation, improving that documentation where needed before removing instructions. Any change needs prompt revision/digest/session-compatibility verification. |
| Native full-turn constraints | `nativeTaskConstraints` adds assigned-skill limits, current agent-file paths, document/file delivery, answered-question handling, and accepted completion/final-response sequencing. Codex/OpenCode add another completion reminder. Prepared constraints reach the model envelope through `native-session-runtime`; compact continuations avoid replaying prior task constraints. | Consolidate duplicate completion instructions. Keep current paths, answer scope, and the required result protocol. Move detailed file/document procedure to discoverable tool descriptions where adequately covered. |
| Task/event-specific framing | Server task Markdown and wake rendering supply work mode, ordered comments, approved revisions, checkout/holds/blockers, recovery/review/watchdog roles, external-chat bookkeeping/delivery, and conversation handoff. | Retain the facts and mode boundaries in the first reduction. Use one authoritative owner for shared mode directives; review specialized wording separately. |

Custom `promptTemplate` and fresh-only `bootstrapPromptTemplate` configuration
are distinct from shipped defaults and should not be silently rewritten.
The built-in process adapter invokes a configured command; HTTP passes context
as JSON. They do not use the shared text template. External adapter plugins and
hosted configuration variants still require the broader item 6 audit.

An accepted-plan discrepancy needs resolution: task Markdown permits cohesive
implementation on the current issue, while the wake renderer's planning-mode
accepted-confirmation branch requires children and prohibits implementation on
the source issue. Existing tests assert both versions. Production reachability
after the server changes work mode has not yet been established; do not claim
this proves a live plan-continuation failure.

Dotta selected follow-up 2.1 first: reduce the common legacy startup/resume
copies, preserving conditional context. Additional carriers and native fixed
instructions remain distinct follow-ups 2.2 and 2.3. No shared runtime text was
changed by the initial inspection.

Coverage identified during inspection includes shared prompt selection/rendering,
adapter execution tests, native backend/runtime context tests, and server
task-context/native-input tests. Follow-up 2.1 extended the shared and adapter
checks; its results are above. Follow-ups 2.2 and 2.3 need their corresponding
carrier/protocol assertions. Product E2E context-integrity, completion-updates,
and direct blocker guidance are candidate lifecycle checks; their current scope
does not establish coding-task quality. The initial inspection itself ran no
tests or live evals.

## 3. Review every hiring and role template

- [ ] Cover default hires, CEO, chief of staff, coder, QA, UX, security, CTO, and
  every other shipped team/role instruction set.
- [ ] Trace onboarding, API/UI/CLI hiring, team imports, and agent-creation skill
  rules so a removed manual is not regenerated through another entry point.
- [ ] For each template, decide: remove it, retain a tiny role description, or
  keep specific domain guidance with a stated reason.
- [ ] Review forced delegation, mandatory memory workflows, procedural review
  routing, comment requirements, and old governance instructions.
- [ ] Update hiring references and draft-review requirements alongside templates.
  Native Runner agents must not be required to follow legacy skill/API procedures
  that their runtime intentionally does not expose.
- [ ] Decide rollout for new hires, existing managed bundles, imported teams,
  and custom agent instructions.
- [ ] If substantial behavioral instructions remain, identify the behavior they
  should improve and add appropriate eval coverage. A tiny role paragraph may
  need only creation/configuration coverage.

Starting points: [onboarding assets](../../server/src/onboarding-assets/),
[default bundle service](../../server/src/services/default-agent-instructions.ts),
[agent routes](../../server/src/routes/agents.ts),
[hiring skill and references](../../skills/paperclip-create-agent/),
[teams catalog](../../packages/teams-catalog/catalog/).

Dotta approved and merged [PR #14985](https://github.com/paperclipai/paperclip/pull/14985)
at `862a5758ba0e88a33232c1f1fa645e85c38a3113`, after corrected source
`57dcee147ed0b2d2e3cc657cd9e50fb16bf9ec25` passed full CI and fresh Greptile 5/5.
The hiring skill/references, CEO/CoS assets and team catalog are now on master.
Their live qualification remains separate from unit/CI verification.
[Prompt diffs and preserved scope](https://github.com/paperclipai/paperclip/blob/57dcee147ed0b2d2e3cc657cd9e50fb16bf9ec25/doc/plans/2026-10-02-hiring-template-prompt-diff.md).

The read-only audit found four onboarding CEO files (1,897 words), a 164-word
CoS manual, four role examples (coder 652, QA 619, UX 1,325, security 1,724 words),
and eight team-catalog manuals. Hiring step 6, the 60–150-line role guide and
review checklist would regenerate the removed operating policies.

- [x] **3.1** Reduce role drafting rules, coder/adapted hire examples and matching
  catalog coder, preserving metadata, auth, permissions and skill selections.
- [x] **3.2** Reduce the CEO bundle/copy, including forced delegation, hiring,
  memory and repeated API recipes.
- [x] **3.3** Review remaining roles/catalog and CoS copy.
- [ ] **3.4** Review specialized built-in/plugin contracts separately; retain
  product-required behavior rather than assuming every rule is redundant.

Custom and existing bundles and governance remain deliberate rollout boundaries.
Specialized Summarizer, Reflection Coach and Wiki Maintainer prompts remain
unchanged for separate product-contract review; optional Content Lead was already
tiny. The generic non-CEO fallback belongs to PR #14948. PR #14985 does not reduce
every shipped specialized agent.

Its explicit `hiring-templates` suite selects native local Codex and ACPX Claude
`hire-coder-template-reuse` cells: a real default CEO, explicitly requested
production hiring skill/coder reference, independently scored saved JSON
artifacts and session reuse. Outcome and source/read coverage are separate;
missing or redacted receipts do not prove no regression. The existing first-task
suite covers actual wizard CoS snapshot selection. The matched union holds the
reduced manual/shared/operational skill and native completion guidance constant,
restoring only 21 historical hiring production/derived sources in baseline.
Frozen candidate `9f5404ad3aacbe76777952759414d34fd381e674` and baseline
`296a4df85e8bcc97a160fc78c291b17adb828196` passed 705 exact-source credential-free
prerequisites each (704 TypeScript + 1 Rust; zero providers), with 8,242 identical
other tracked files and matching fixture/model/auth/permissions configuration.
Only four candidate-specific single-file CEO selection assertions are filtered
symmetrically; each variant's bundle/source hashes and canonical catalog are
independently admitted. Two cells per variant, five expected turns each:
four cells / 20 turns, 15 minutes each, no automatic retries or broader selection.
The [candidate](https://github.com/paperclipai/paperclip/actions/runs/37075466208)
and [baseline](https://github.com/paperclipai/paperclip/actions/runs/37075469463)
protected campaigns are dispatched. No graded live pairs yet; pending evidence
cannot establish non-regression.
[Inspect the partial report](https://github.com/paperclipai/paperclip/blob/e3720f369df070036526dd295a7a68e49488c51a/doc/plans/2026-10-02-hiring-template-live-comparison.md).
Report-only updates preserve the measured refs and merged hiring PR.

The default-manual PR is replayed on the merged hiring base, preserving custom
CEO bundle checks, the minimal generic boundary and both eval suites. Its prior
browser failure remains retained: a deterministic process fixture replayed its
last plan command on an asynchronous `chat_task_completed` wake and wrote a
second, text-identical source plan revision. It was not paid/provider execution;
fresh rebased CI remains required before readiness.

## 4. Fix repository context while retaining Paperclip configuration

- [ ] Map instruction discovery and precedence for each harness: repository
  AGENTS.md/CLAUDE.md or equivalent, project/local settings, isolated homes, and
  explicit Paperclip instruction injection.
- [ ] Distinguish repository instructions from settings that also load MCPs,
  plugins, credentials, or skills; choose selective loading/injection as needed.
- [ ] Verify repository instructions are available in the correct workspace,
  including worktrees, remote execution, and resumed sessions.
- [ ] Verify assigned skill discovery/pinning, authentication, Paperclip MCP
  ownership, tool authorization, and configuration-change invalidation.
- [ ] Record intentional isolation separately from accidental lost context.

Claude starting points: [local adapter](../../packages/adapters/claude-local/src/server/execute.ts),
[ACP patch](../../patches/@agentclientprotocol__claude-agent-acp@0.73.0.patch),
[runtime sandbox](../../packages/paperclip-runner/src/drivers/acpx/runtime-sandbox.ts).

Decision: repository-context loading mechanism per harness pending. Personal MCP
isolation is approved and should remain.

## 5. Let the runtime own bookkeeping

- [x] **Native completion delivery slice.** Persist and present meaningful final
  answers, saved document links and blocker details; settle accepted/rejected
  OpenCode completion feedback correctly. Merged in #15151. This does not finish
  the wider checkout, waiting, recovery and legacy ownership audit below.
- [ ] Map which runtime owns checkout, status transitions, completion comments,
  artifacts, waiting/review states, and recovery; identify manual duplicates.
- [ ] Keep one valid completion path per runtime and preserve meaningful user
  questions, approval requests, dependency waits, and final deliverables.
- [ ] Remove agent instructions for operations the runtime already performs;
  retain necessary coordination for legacy/external adapters.
- [ ] Verify durable task state, visible final answer, artifact access, audit,
  and restart/recovery behavior through the real product paths.

Decision: exact runtime responsibilities and legacy compatibility pending.

## 6. Complete the harness and configuration coverage audit

This matrix is an inventory seed, not a claim that every path has been audited
or qualified. Expand it from the registry and provider/profile definitions.
For every numbered change, record applicability here or an explicit reason it
does not apply.

| Execution family | Paths to cover | Audit status |
| --- | --- | --- |
| Legacy Codex / Claude | Local adapters, managed auth and isolated configuration | Initial inspection only |
| Other legacy local adapters | ACPX, OpenCode, Pi, Cursor, Gemini, Grok, Kimi, Hermes | Pending |
| Other adapter transports | Cursor Cloud, Hermes/OpenClaw gateways, process, HTTP, external adapter plugins | Pending |
| Runner Codex | App-server driver, runnerd bridge, Rust provider, direct/fallback paths | Additive instruction fix merged in PR #14920 |
| Runner ACPX | Enabled profiles, especially Claude/Grok; declared or pending profiles tracked separately | Claude initial inspection; remaining audit pending |
| Runner OpenCode | Native provider and configuration paths | Pending |
| Hosted/remote providers | Claude Managed and AWS AgentCore; identify their own baseline rather than assuming CLI semantics | Pending |

- [ ] Inventory supported profiles and qualification status from the
  [adapter registry](../../server/src/adapters/registry.ts) and
  [provider resolver](../../server/src/services/native-runtime/provider-profile.ts).
- [ ] Cover local/remote environments, fresh/resumed sessions, managed/custom
  hires, task/chat/planning flows, and auth/configuration variants as applicable.
- [ ] Audit restrictions on tools, skills, subagents, memory, and other harness
  capabilities. Trace effective provider configuration, not just intermediate
  configuration objects; document intentional limits and decide accidental ones.
- [ ] Check shared fixes reach every relevant adapter; document provider-specific
  exceptions instead of silently extending a Codex/Claude assumption.

## Verification and evals — apply to each item

- [x] Repair strict retained-run accounting in #15007 and add bounded native
  completion/final-answer coverage for #14961/#15151. Keep original failures;
  ACPX host/provider action attribution and hiring source-read coverage remain
  explicitly uncomparable where no authoritative mapping/receipt exists.
- [x] Map existing coverage for all implemented changes before adding cases;
  see the SH-1–SH-3 map below and [doc/evals.md](../evals.md).
  Keep Runner protocol evals and Product E2E evals distinct.
- [x] Set up narrow deterministic checks for the implemented instruction layering,
  hire, and shared-prompt changes. Future changes still need their own map for effective
  configuration, skill/auth delivery, and session behavior where appropriate.
- [x] Reuse existing protocol tests for native Codex request layering and add Product
  E2E for production-default hiring, skill delivery, task lifecycle, and chat
  continuity. Repository context and additional artifact cases remain future work.
- [x] Review existing suites for reusable coverage. Their custom QA manuals did
  not exercise the tiny default hire; the new suite deliberately omits those
  bundles and reuses independently graded skill, continuation, and chat journeys.
- [ ] Compare task quality as well as Paperclip protocol compliance when claiming
  that fewer instructions improve agent performance. Keep model, effort,
  permissions, tools, and fixture comparable.
- [ ] Select narrow live cells when implementation is ready; retain revisions,
  profile/environment, grader, retries, usage/cost, and failure classification.
- [ ] Run the relevant checks for each change and the repository's required full
  verification before a PR-ready handoff. Record unrun checks and their reasons.

### Coverage for changes implemented so far

The [stock-harness runbook](../../tests/runner-e2e/STOCK-HARNESS.md) defines a
credential-free prerequisite plus 24 explicit local Product E2E cells across
eight legacy/native profiles. Each profile runs assigned-skill invocation,
ordered comment continuation, and chat continuity across restart. Public receipts
verify the identity-only managed bundle before provider execution; final receipts
check actual legacy prompts and both budget hard stops. The existing lifecycle
oracles still own task/chat success. Models, auth, skills, permissions, and
secret-reference plumbing are inherited from existing profiles.

| Coverage ID | Implemented change | Executable coverage | Live status |
| --- | --- | --- | --- |
| SH-1 | Native Codex additive developer instructions, including start/resume/recovery | TypeScript driver, runnerd transport, Runner Lab/live-session, and Rust provider tests in `pnpm test:e2e:runner:stock-harness`; native Codex cells exercise real hires. | Native Codex passes all three matched journeys in both variants; #14920 held constant, so task success is not before/after vendor-base proof. |
| SH-2 | Eight-word default hire `AGENTS.md` | Public creation/onboarding tests; exact independent public bundle oracle before and after provider execution for every stock-harness cell. | Candidate public tiny-bundle and budget receipts pass in all 24 retained cells. Behavioral delivery is not fully qualified; see F14–F17. |
| SH-3 | Reduced shared task/chat defaults and removed generic resume contract | Shared renderer and ACPX/Codex/OpenCode/Pi/Hermes/Cursor Cloud regressions; actual legacy invocation prompts checked in the new suite. | Actual legacy prompts measured. Document-delivery regressions and clipped/missing receipts retained; additional carriers remain deferred item 2.2. |

The suite is explicit-only and excluded from `--all`; it does not add paid work
to ordinary campaigns. Negative calibration covers manual regrowth, missing or
malformed prompt receipts, old startup/resume procedures, missing connection
guidance, wrong budgets, and skipped prerequisite assertions. Source revisions,
attempts, cost, partial failures, cleanup, and sanitized evidence use the existing
report pipeline. No paid providers were launched during the initial setup.
Subsequent GitHub measurements are recorded below; no broad coding-quality
improvement or full live qualification is claimed. Unrepresented harnesses remain
unqualified; Codex-through-ACP vendor-base preservation is still F7.

Local setup verification: 478 prerequisite tests passed (477 TypeScript plus one
Rust), 860 Product E2E support tests passed, E2E typecheck passed, and all 24 cells
were discovered. The 313 unrelated native tests filtered by the gate are not
passing coverage. Final prerequisite evidence is retained at
`tests/runner-e2e/results/stock-harness-preflight-2026-10-02T16-15-39.064Z/preflight.json`;
earlier interrupted, missing-Hermes-discovery, and setup/test-timeout attempts are
retained as failures. Hermes is checked through its package config because the
root Vitest project list omits it. Later exact-head prerequisites expanded to
557 passed checks (556 TypeScript and one Rust), and E2E support to 895 tests.
Repository typecheck/build passed. The complete local Vitest run retained three
unrelated timing failures; all three files passed unchanged reruns. At
`1eb5ba420`, 52 CI gates pass and two skip; Greptile is 5/5 with zero open
threads. Later documentation heads require fresh checks. See the live report
for exact source hashes, campaigns, failures and cost limitations.

## Findings ledger

Confirmed mechanics below do not by themselves establish an effect on task quality.

| ID | Finding | Work item / disposition |
| --- | --- | --- |
| F1 | Native Codex sent Paperclip text as `baseInstructions`. Probes on codex-cli 0.153.4 showed replacement; additive `developerInstructions` retained the stock base on start and cold resume. | 1; app-server fix merged in PR #14920 |
| F2 | Default hires and role templates prescribe substantial operating procedures; common prompt and wake layers add further coordination text. | 2–3; mechanics confirmed, performance effect unmeasured |
| F3 | Hiring references require legacy Paperclip skill/comment procedures, while native Runner intentionally omits that operational skill and uses semantic tools. | 2–3, 5; reconcile runtime contracts |
| F4 | Local Claude appends instructions; Runner Claude preserves the Claude Code preset. Runner isolation excludes project/local settings, which can also exclude repository instruction discovery. | 4; selective context fix to design |
| F5 | Some Codex capability settings differ between the direct driver and daemon path; an intermediate configuration does not prove the final provider behavior. | 6; effective-path audit pending |
| F6 | Omitting or nulling `baseInstructions` on an old Codex thread's resume preserves its saved replacement; an empty string produces an empty base. | 1; document the required provider session reset; no automatic migration in this PR |
| F7 | The isolated Codex-through-ACP dependency patch also sets `baseInstructions` on start/resume. It is a separate path from the native app-server backend. | 6; follow-up patch/profile audit pending |
| F8 | The operational skill says target-bound confirmations default `supersedeOnUserComment` to true; the default manual and server normalizer say false. The server uses false. | 2; correct stale skill/reference guidance in a follow-up |
| F9 | The default manual required a comment on every task, while the operational skill's verified external-chat shortcut delegates comments and lifecycle bookkeeping to the harness. | 2; unconditional manual rule removed; shared layers still need review |
| F10 | Removing the default manual left the 661-word legacy task template and its 172-word resumed-wake execution contract. Hermes and Pi have additional policy carriers. | 2.1 complete locally: task/chat defaults 113 words, no generic resume contract; 2.2 wrappers pending |
| F11 | Task Markdown and the wake renderer prescribe different accepted-plan behavior for planning-mode accepted-confirmation payloads; tests currently expect both. | 2; unify the directive owner; production reachability still to trace |
| F12 | Native fixed instructions and full-turn constraints repeat completion and uncommon procedures, while reserved finish/block tool descriptions are only one sentence each. | 2; improve tool documentation before removing needed native protocol guidance |
| F13 | Existing context-integrity/chat fixtures injected a QA manual, so their green results did not qualify the production tiny hire default. | Dedicated stock-harness suite measured real default hires; retained failures prevent blanket qualification. |
| F14 | Historical classic Claude/OpenCode skill runs save one Paperclip document; reduced runs save none while completing the task. Legacy ACP Claude has the same behavior under a separate guard failure. Pinned skill storage wording is ambiguous. | Measured delivery failures; keep original oracle. Improve legacy skill/API delivery guidance separately, then compare both variants with preserved and storage-specific cases. |
| F15 | Classic Claude restart chat fails its memory assertion in both variants. | Existing behavior, not attributable to this reduction from these trials. |
| F16 | All six legacy ACP cells per variant fail the persisted-provider-credential guard. Three historical ACP cells also have clipped public prompt retrieval, and candidate ACP Codex chat lacks a complete invocation receipt. | Security/receipt qualification follow-ups; do not waive guard, expose raw sessions, or infer missing provider instructions from clipped receipts. |
| F17 | Prerequisites beside the campaign root violate trusted artifact selection. A same-target pilot superseded 13 candidate cells; one historical AWS runner shut down without upload. | Packaging fixed at `1eb5ba420` and pilot passes. Directory-layout-only copies preserve every byte; missing cells alone recovered at unchanged source, completed failures never rerun. |

Append new findings with evidence, affected paths, and the numbered item that
will address them. Record intentional behavior explicitly rather than as a bug.

## Decision and completion log

| Date | Decision / outcome | Evidence / follow-up |
| --- | --- | --- |
| 2026-10-05 | Dotta merged #15151; reconcile the saved roadmap with completed implementation/evidence notes. | Native completion slice complete; general hiring reductions and common legacy prompts also merged. 2.2, remaining fixed native procedures, 3.4 and the broader 4–6 audits stay open. Preserve old failures and bounded qualification limits; no new model run or public report publication in this checklist update. |
| 2026-10-02 | Dotta approved preserving stock instructions, smaller defaults/templates, minimal coordination, runtime bookkeeping, and coverage across harnesses. | Implementation details to work through one item at a time. |
| 2026-10-02 | Paperclip-owned MCP isolation and configuration changes/session resets are acceptable. | Preserve Paperclip auth and assigned skills while fixing repository context. |
| 2026-10-02 | Dotta requested implementation and a PR for item 1. Native app-server paths now use additive developer instructions. | 139 targeted TypeScript tests and 91 Rust provider tests passed; repository typecheck/build passed. Remaining test/review results to record. |
| 2026-10-02 | Verified actual Codex instruction layering using a localhost Responses stub, without paid inference. | codex-cli 0.153.4 sent identical 14,732-character stock base instructions on start and cold resume, with the Paperclip marker retained in developer input. This is protocol evidence, not a task-quality eval. |
| 2026-10-02 | Dotta requested and confirmed the merge of item 1. | PR #14920 merged at `408f70e69f9c5e49cb4377f4886ac2001bfa67a2`, with all 55 checks passing and Greptile 5/5. |
| 2026-10-02 | Dotta directed an identity-only default manual with no skill or runtime pointers; the harness already handles coordination. | Reduced the default to eight words. Existing hire and onboarding suites passed all 64 tests. Shared prompts and role templates remain pending. |
| 2026-10-02 | Dotta requested three explicit shared-prompt follow-ups and selected common legacy startup/resume reduction first. | Follow-ups 2.1–2.3 recorded. 2.1 complete locally: both defaults 113 words; generic resume contract removed. 563 focused tests and shared utility typecheck/build passed. Extra carriers and native instruction reduction remain pending. |
| 2026-10-02 | Dotta requested executable eval coverage for everything implemented so far and all subsequent changes before continuing. | Added SH-1–SH-3 coverage map, credential-free prerequisite, and 24 production-default-hire cells. 478 prerequisite and 860 support tests passed; E2E typecheck/discovery passed. Live provider results remain `not_run`; item 2.2/2.3 unchanged. |
| 2026-10-02 | Dotta requested PRs and GitHub-runner before/after qualification while discussing subsequent work separately. | Draft [PR #14948](https://github.com/paperclipai/paperclip/pull/14948); native Codex diagnostic [passed](https://github.com/paperclipai/paperclip/actions/runs/37034213743), 34.745 s provider / 56.660 s cell. Comparison restores only the prior manual/shared prompts and holds #14920 constant; no general coding-quality claim. |
| 2026-10-02 | Full candidate cold setup failed before provider admission; stopped and retained the attempt. | [Run 37037105491](https://github.com/paperclipai/paperclip/actions/runs/37037105491), target `36e987246`: prerequisite imports lacked the plugin SDK build. Added ordinary dependency setup before credential-free prerequisites and exact-source coverage of connection guidance. Cold pilot and full matched campaigns pending. |
| 2026-10-02 | Dotta deferred 2.2 additional legacy carriers and approved the first 2.3 native tool-description slice separately. | Keep wrappers open; native finish/block documentation must not be supplied to legacy skill/API completion paths. |
| 2026-10-02 | Matched default-manual/shared-prompt campaigns measured failures, with #14920 constant. | Candidate `f02d8d0df`: 15/24 pass. Historical `12c5433c6`: 15/24 pass after the one runner-shutdown recovery also timed out. Classic Claude/OpenCode Paperclip document delivery regressed in observed trials; keep PR #14948 draft. [Live report](2026-10-02-stock-harness-live-comparison.md). |
| 2026-10-02 | Cold prerequisite and packaging faults were repaired without weakening admission or behavioral graders. | Three setup attempts stopped before providers. Current `1eb5ba420` pilot passes 557 prerequisite checks and protected report publication; source/hash/cost evidence retained. Candidate cancellation and historical runner shutdown recovered only for missing cells. |
| 2026-10-02 | Final bounded recovery completed; no further model reruns. | Both matched cohorts have all 24 results, 15 pass and nine fail. Two classic skill deliveries regress; two OpenCode ordered cases pass only with reduced instructions. Overall parity is not behavioral equivalence. All 48 retained result/receipt projections are hashed and sanitized; original interruptions and partial unknown spend remain recorded. |
| 2026-10-02 | Dotta approved the measured legacy delivery repair and narrow follow-up qualification. | Early operational skill PUT/receipt/link guidance plus generic issue-document reference; eight-word manual retained. Focused original + explicit Paperclip-storage cases on classic Claude/OpenCode, with only the two skill sources varied. All four pairs completed: Claude original Fail → Pass, Claude explicit Pass → Pass, both OpenCode cases Fail → Fail. Explicit OpenCode handoff worsened beneath the unchanged machine grade (clickable API URL → code-formatted path). [Repair report](2026-10-02-legacy-document-skill-repair.md); no full matrix rerun. Claude chat-memory (F15) and ACP credential/receipt failures (F16) remain separate and unresolved. |
| 2026-10-02 | Native tool-description comparison completed all six paired cases. | Zero newly failing cases, three unchanged completion passes, three unchanged blocker failures. Claude/OpenCode blocker API matchers pass in both variants; UI matcher wrongly demanded marker-only replies. Codex's exact-action punctuation failure is unchanged. Original failures retained; corrected 10-case browser calibration and separate retained-DOM replay pass all six visible replies. Exact Codex action failures remain. No native fixed-prompt removal measured. |
| 2026-10-02 | Dotta approved minimal operational skill selection/link correction after retained OpenCode diagnosis. | Candidate `fe9dc1e3c` and baseline `0d7ecfa96d` have two matched Pass → Pass cases, zero new failures/passes and no pending pairs. All four exact-source gates pass 587 checks, all four provider runs and cleanup pass. Candidate original loads Paperclip/reference before delivery, but uses the wrong PAP prefix; baseline original saves publicly later within the same assignment and gives a bare path. Explicit clickable UI links are correct in both. [Complete report](2026-10-02-opencode-skill-routing-link-qualification.md); prior failures retained, no causal or broad quality claim. |

- F18: Native blocker browser assertion required a marker-only reply despite asking for owner/action/reason. Correct marker-plus-explanation checks symmetrically, calibrate contradictory and future-condition replies, retain original verdicts.
- F19: Original prompt-removal cohorts loaded Paperclip; OpenCode skill truncation omitted the late API recipe. The early repair fixed Claude in one paired trial. In the repaired original OpenCode assignment, Paperclip was first loaded only during disposition recovery after a local-file write. Shared legacy operational-skill delivery/selection needs review before more recipe expansion.
- F20: Explicit repaired OpenCode reads the early recipe/reference and saves a public document/revision, but hands off a code-formatted path rather than a clickable anchor. Baseline provides a clickable API URL, rejected by the UI-only oracle. Preserve both grades; clarify future clickable UI-link fixture and review the smallest link example separately.
- F22: Legacy operational skill mounting is already mandatory, but its discovery description omitted ordinary task/heartbeat work and document delivery. The approved narrow fix expands stock metadata selection and adds a real Markdown link example in the existing reference. Original + clarified-explicit OpenCode pairs both pass in both variants, so improvement causality is not established. Candidate loads the operational skill/reference before public delivery; baseline original writes locally first, then saves publicly in the same assignment. Original candidate copies the example PAP prefix into its link while baseline supplies a bare slug path; neither is scored by the original link-free oracle. No full-body injection or native-tool leakage. ACP Claude names-only metadata, custom ACP unsupported delivery, OpenClaw wrappers and Pi HOME differences remain distinct follow-ups.
- F23: The new original OpenCode candidate copies `/PAP/issues/RUN-1#document-context-integrity-output` from the literal example despite actual prefix RUN. It passes durable-document grading but has an incorrect-prefix handoff. Baseline original also lacks a clickable canonical link. Approved reference-only correction now derives the link from `issue.identifier` and the saved receipt key. Independent provider-free calibration checks two other prefixes, redirected keys and rejects a wrong-company link; 25 focused document/source tests, canonical metadata checks and E2E typecheck pass. The recipe now also handles null/absent identifiers through the supported issue-ID route; fresh review caught the initial nullable edge. 56 focused checks pass. Source review shows the UI corrects wrong prefixes, so the frozen PAP href is noncanonical rather than proven broken. These later corrections are not live-qualified by the preserved runs; no further paid rerun.
- F21: Skill heading insertion shifted both generated capability inventories. General CI caught stale metadata after the frozen repair campaign’s narrower build admitted providers. Regenerate canonical derived files and require stale-manifest/inventory checks before future provider admission.

For each completed item, add the chosen behavior, changed paths, verification
results, remaining exceptions, and follow-ups here before checking it off.


### 2026-10-05 final PR #15218 scope

- [x] Preserve all three experimental cohorts and failed original grades.
- [x] Reject the unqualified procedure relocation; final production bytes match master a65ca0950834a85bb93bcc4b4042ecacdebfef53.
- [x] Keep complete native-tool measurement, explicit workflow coverage, selected-provider credentials and budget guards.
- [x] Full local typecheck/build and 1,252 eval-support + 128 Node tests pass.
- [x] Final head 2e7cef78eef7cdfe02265e0dcb03e855b8e50bd8: all 47 CI jobs pass; one initial annotation-test timeout retained and one targeted retry passed. Fresh Greptile 5/5, three threads resolved, published body verified, both ready-transition security scans pass, MERGEABLE and no longer draft.
- [x] PR #15218 merged on 2026-10-06 at 01:03 UTC. The preceding approval hold is historical; the final merged scope is measurement and eval coverage with production unchanged.
- [ ] Section 2.3 procedure relocation remains unshipped; the trials do not justify it. Runtime follow-up preserved separately and unqualified.


### 2026-10-06 roadmap update

- [x] **#15218 merged:** complete native-tool measurement and explicit hiring/delegation eval coverage. The proposed production procedure relocation failed qualification and was excluded. Original failures remain recorded.
- [x] **#15296 merged:** shrink the runtime and bundled plan-to-tasks skills while retaining their installation keys and accepted-plan wiring. GitHub records the merge at 14:36 UTC. The detailed completed comparison report remains local pending its separate publication consent; merging the implementation does not publish that report.
- [ ] **Next bounded repair:** a reopened native child must notify its parent after its new completion, even when the first notification has already been consumed. Replaying the same committed completion must not create another wake. Work is on `codex/delegation-handoff`, based on master `0fe47882cfcb12082035113c59ca96091c46ebfc`.
- [x] **#15372 implemented and deterministically verified:** ordinary native child completion wakes include the durable decision ID; exact watchdog behavior and replay deduplication are preserved. Both ordinary regressions fail on baseline, and all 20 database-backed cases pass with the repair. Current head `a2ae2324ce7692e704fc43e99904b076d6246fee` has full green CI and fresh 5/5 review; it remains draft because the completed live comparison contains a new failure.
- [ ] **#15372 live qualification failed; keep draft:** Codex PASS → FAIL, Claude FAIL → PASS. One new failure, one new pass, no pending pairs; equal totals do not prove non-regression. Four completed cells contain 17 actual agent runs, no retries, cleanup passed. Candidate Codex's revised child completion wakes coalesced into an active parent, which later ended Blocked using an outdated child-running view; no later parent execution is retained. A later backstop log reports repair but does not prove eventual completion. That cell never reached the independent ZIP oracle. The unstarted candidate Codex queue job was cancelled with no runner/steps before its first actual trial in campaign `37513070706`. Four earlier composer setup failures had zero agent runs and remain preserved. Original grades are unchanged; no causal attribution or reroll.
- [ ] **Latest child delivery/review remains open:** both Claude parent finals point to an earlier parent ZIP while the original oracle checks the revised child's ZIP. The candidate's passing grade does not qualify delivery/review of that latest artifact. Parent ZIP bytes were not retained, so a different hash alone is not proof of missing functionality. This is separate from the consumed-wake regression. Preserve original grades.
- [ ] Revisit hiring/dependency instruction reduction only after the bounded behavior is qualified. Premature parent completion, discarded unfinished dependencies and broader latest-child review remain separate open behavior questions.
- [ ] Audit connection procedures separately, then return to the remaining 2.2 / 3.4 / 4–6 work.

#### #15372 reporting disposition — 2026-10-06

The complete original comparison and diagnosis are saved privately at
[immutable evidence archive](https://github.com/paperclipai/paperclip-evals/blob/a3fdf327907816c22c4097da8839db4f472d5e9c/experiments/2026-10-native-delegation-handoff/README.md).
The prepared public body is `/private/tmp/delegation-handoff-pr-body.md`.
The human explicitly authorized publication and requested fixing the failures.
The prepared summary was published normally to PR #15372; the earlier automatic
review hold is resolved for this summary. The original comparison remains unchanged.

#### #15372 active-parent repair — 2026-10-06

- [x] Implement durable delivery of ordinary native child completions to a fresh parent turn when the parent is already running; preserve exact watchdog behavior.
- [x] Keep a parent non-terminal while a newer native child result remains queued or deferred, with a commit-time recheck. Preserve terminal cancellation and governance authority; do not create a second continuation.
- [x] Provider-free verification: 67 focused scheduler/native-conformance/authority tests and repository typecheck pass. The scheduler regression holds the parent open, dispatches/replays the child result, then verifies exactly one sequential continuation with the latest summary. Pending, consumed and current-run delivery identities have native finalization coverage.
- [ ] Freeze and measure the corrected source in the same two original live cases, one attempt each. Do not reroll the original baseline or regrade the failed candidate.
- [ ] Verify the latest source head in CI/review and inspect final parent artifact delivery before claiming readiness. Keep draft until these gates pass.

- [x] Preserve intermediate campaign `37518652522` as two cancelled, ungraded attempts on `3c1cf68`; provider activity/charges and cleanup are unverified because only invocation policies survived. These are separate from the original 17 actual runs.
- [x] Audit the concurrency review finding with a real database barrier and distinct agents. Existing implicit locking serializes this tested ordering; make the parent lock explicit before child status writes. Do not claim a newly reproduced live defect.
- [ ] Finish fresh source checks/review, then qualify the corrected source against the frozen baseline and inspect latest-artifact delivery.
- [x] Explicit-lock revision: 68 focused tests and full repository typecheck pass. Fresh build, CI/review and live checks remain pending.
