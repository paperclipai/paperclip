# Stock harness, with Paperclip: working checklist

Created: 2026-10-02. Status: item 1 implemented for native Codex app-server;
PR validation in progress. Other implementation items remain open.

Goal: keep the agent's stock harness behavior and add only what it needs to work
with Paperclip. Apply this across legacy adapters, the new Runner, and their
configuration variants.

We will work through the numbered items one at a time with Dotta. For each item,
record the proposed behavior and Dotta's direction, make a bounded change, and
verify the affected paths before moving on. New findings get stable IDs in the
ledger below so they do not disappear into conversation history.

**Current item: 1 — validate and review the native Codex instruction fix.**

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
- [ ] Verify Paperclip task context, tools, auth, assigned skills, and completion
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

## 2. Reduce the default operating manual and shared prompt layers

- [ ] Inventory what an agent actually receives: hire instructions, shared
  prompt template, wake context, runtime prompt, bootstrap, and loaded skills.
  Separate always-present text from content loaded on demand.
- [ ] Agree on the tiny common contract and the coordination details that each
  runtime still requires. Legacy API coordination and native semantic tools
  need appropriate instructions for their respective interfaces.
- [ ] Remove repeated workflow rules and stock coding/style/autonomy guidance.
- [ ] Move detailed planning, hiring, artifacts, and exceptional procedures to
  discoverable references or tools where feasible.
- [ ] Check fresh and resumed task/chat flows for instruction duplication and
  contradictory completion or waiting rules.

Starting points: [default hire instructions](../../server/src/onboarding-assets/default/AGENTS.md),
[shared adapter utilities](../../packages/adapter-utils/src/server-utils.ts),
[native runtime contract](../../packages/paperclip-runner/src/contracts/runtime-context.ts),
[Paperclip operational skill](../../skills/paperclip/SKILL.md).

Decision: exact retained paragraph and on-demand boundaries pending.

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

Decision: per-template disposition and migration policy pending.

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
| Runner Codex | App-server driver, runnerd bridge, Rust provider, direct/fallback paths | Additive instruction fix implemented; PR validation pending |
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

- [ ] Map existing coverage before adding cases; use [doc/evals.md](../evals.md).
  Keep Runner protocol evals and Product E2E evals distinct.
- [ ] Start with narrow deterministic checks for instruction layering, effective
  configuration, skill/auth delivery, and session behavior where appropriate.
- [ ] Use Runner evals for provider/session/tool protocol changes; use Product
  E2E for real hiring, repository context, task lifecycle, and artifact delivery.
- [ ] Review existing context-integrity, hiring, completion-updates, and blocker
  suites for reusable coverage; record gaps rather than claiming coverage from
  a similarly named case.
- [ ] Compare task quality as well as Paperclip protocol compliance when claiming
  that fewer instructions improve agent performance. Keep model, effort,
  permissions, tools, and fixture comparable.
- [ ] Select narrow live cells when implementation is ready; retain revisions,
  profile/environment, grader, retries, usage/cost, and failure classification.
- [ ] Run the relevant checks for each change and the repository's required full
  verification before a PR-ready handoff. Record unrun checks and their reasons.

## Findings ledger

Confirmed mechanics below do not by themselves establish an effect on task quality.

| ID | Finding | Work item / disposition |
| --- | --- | --- |
| F1 | Native Codex sent Paperclip text as `baseInstructions`. Probes on codex-cli 0.153.4 showed replacement; additive `developerInstructions` retained the stock base on start and cold resume. | 1; app-server fix implemented, PR validation pending |
| F2 | Default hires and role templates prescribe substantial operating procedures; common prompt and wake layers add further coordination text. | 2–3; mechanics confirmed, performance effect unmeasured |
| F3 | Hiring references require legacy Paperclip skill/comment procedures, while native Runner intentionally omits that operational skill and uses semantic tools. | 2–3, 5; reconcile runtime contracts |
| F4 | Local Claude appends instructions; Runner Claude preserves the Claude Code preset. Runner isolation excludes project/local settings, which can also exclude repository instruction discovery. | 4; selective context fix to design |
| F5 | Some Codex capability settings differ between the direct driver and daemon path; an intermediate configuration does not prove the final provider behavior. | 6; effective-path audit pending |
| F6 | Omitting or nulling `baseInstructions` on an old Codex thread's resume preserves its saved replacement; an empty string produces an empty base. | 1; document the required provider session reset; no automatic migration in this PR |
| F7 | The isolated Codex-through-ACP dependency patch also sets `baseInstructions` on start/resume. It is a separate path from the native app-server backend. | 6; follow-up patch/profile audit pending |

Append new findings with evidence, affected paths, and the numbered item that
will address them. Record intentional behavior explicitly rather than as a bug.

## Decision and completion log

| Date | Decision / outcome | Evidence / follow-up |
| --- | --- | --- |
| 2026-10-02 | Dotta approved preserving stock instructions, smaller defaults/templates, minimal coordination, runtime bookkeeping, and coverage across harnesses. | Implementation details to work through one item at a time. |
| 2026-10-02 | Paperclip-owned MCP isolation and configuration changes/session resets are acceptable. | Preserve Paperclip auth and assigned skills while fixing repository context. |
| 2026-10-02 | Dotta requested implementation and a PR for item 1. Native app-server paths now use additive developer instructions. | 139 targeted TypeScript tests and 91 Rust provider tests passed; repository typecheck/build passed. Remaining test/review results to record. |
| 2026-10-02 | Verified actual Codex instruction layering using a localhost Responses stub, without paid inference. | codex-cli 0.153.4 sent identical 14,732-character stock base instructions on start and cold resume, with the Paperclip marker retained in developer input. This is protocol evidence, not a task-quality eval. |

For each completed item, add the chosen behavior, changed paths, verification
results, remaining exceptions, and follow-ups here before checking it off.
