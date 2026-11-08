# Pool Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework PR #19481 into a selectable Pool harness backed by centrally managed, company-scoped pools of complete harness/model/account configurations, including reusable Smart, Mid, and Cheap templates.

**Architecture:** Pool is a virtual execution choice resolved by Paperclip before native Runner admission. It delegates to an existing concrete harness driver; it does not introduce another agent loop, nested Runner, or competing run owner. Reuse the current PR's durable allocation, cooldown, session isolation, settlement, and successor machinery.

**Tech Stack:** TypeScript, Zod, existing Drizzle/PostgreSQL pool records, Express, React, native Paperclip Runner and existing Codex/ACPX/OpenCode drivers.

**Spec:** The product and architecture decisions in sections 1–4 of this document; existing contracts in `doc/SPEC-implementation.md`, `doc/connections/AI-CONNECTION-ROUTERS.md`, and `doc/RUNNER-INTEGRATION-PLAYBOOK.md` remain authoritative for execution and safety.

## Global Constraints

- Company scope, current responsible-user authorization, atomic issue checkout, approval gates, budget hard stops, and mutation activity logging remain authoritative.
- Native Runner's existing experimental enablement and environment qualification remain in force. Selecting Pool must not silently enable them or convert an agent.
- Reuse existing concrete harness drivers and existing native admission. Do not add `provider: pool` to the Rust wire protocol or create a second run for wrapper bookkeeping.
- Initial pool members use the four already implemented families: Claude Code, Codex, Grok, and OpenCode. Show only combinations qualified for the chosen environment; no blanket promise for every harness or platform.
- Windows and Linux are first-release targets. Local execution is the acceptance environment; SSH/sandbox availability is inherited only from independently qualified existing drivers.
- Models are selected from actual authorized catalogs or explicitly validated IDs. Smart/Mid/Cheap are editable names/templates, not hardcoded model versions or hidden quality classifiers.
- Keep one canonical pool/pin/cooldown store. Preserve existing IDs, company foreign keys, revisions, credential epochs, and historical run snapshots.
- UI changes use existing design tokens and pass `pnpm check:token-gates`.
- Do not edit the user's dirty lockfile, TaskChatComposer, attachments, or other worktrees. Do not restart services, change agent bindings, push, or merge during this planning task.

## Review Focus

1. A task pinned before a pool edit must retain its historical execution identity while new dispatch still rechecks current account access.
2. A pool containing two models on the same account must not treat them as independent quota capacity.
3. A switch to a different harness must not reuse a foreign provider session or advertise the union of all members' capabilities.
4. Stop, revoked authorization, an unresolved mutation, and concurrent failure handling must prevent unauthorized or duplicate successors.
5. Old API clients, built-in pool bindings, plugin-owned routers, and legacy runs must not be silently reinterpreted as native Pool runs.

## 1. Decision: Pool harness first; proxy remains optional

The requested member is a complete execution configuration: harness + model/effort + authorized account. Example: Smart can prefer Claude Code with one configured model/account and fall back to Codex with another. Mid and Cheap work identically with different chosen members. Names do not grant permissions or impose automatic model upgrades.

An HTTP proxy changes model requests behind a harness. It can keep that harness's agent loop alive through an upstream account switch, but does not switch the complete Claude Code execution into a Codex execution. That makes it an alternative for a different goal, not the default implementation of this request.

| Decision | Pool harness | Proxy-only variant |
| --- | --- | --- |
| Swap full harness configurations | Delegates to the selected existing driver | Keeps the caller's harness; translates/routes its API requests |
| Native provider features | Retains each selected driver's qualified surface | Depends on the chosen protocol translation |
| Conversation continuity | Native resume on the same compatible member; bounded handoff on incompatible changes | The harness retains its history, but upstream state and translated tool calls still require qualification |
| Current PR reuse | Allocation, receipts, cooldowns, Stop fencing, and continuation already exist | Requires a managed gateway integration and separate lifecycle/account configuration |

**Recommendation:** Implement the virtual Pool harness. Keep ordinary direct harness selection. Allow an already-supported gateway connection as a member only when its target harness/protocol passes the same compatibility checks. Defer proxy installation, EasyCLIProxyAPI management links, and proxy-specific account administration to a separate optional connector/plugin feature.

Research checked 2026-11-07: [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), its [configuration](https://github.com/router-for-me/CLIProxyAPI/blob/main/config.example.yaml), and [LiteLLM subscriptions](https://docs.litellm.ai/docs/subscriptions). Their documentation establishes available routing features, not Paperclip compatibility or a passing end-to-end comparison. No proxy was installed or benchmarked for this plan.

## 2. User experience and behavior

Agent configuration separates:

1. **Runner:** Paperclip Runner, with current readiness/experimental restrictions.
2. **Harness:** a concrete harness or **Pool**.
3. **When Pool is selected:** a central pool selector, a short ordered member summary, and **Manage pools**. Model/account controls belong to each member rather than a conflicting primary configuration on the agent.

Central management appears at a company-scoped **Harness pools** page. It supports list/create/edit/disable/archive, revision-safe saves, ordered members, connection readiness, and references to agents using each pool. Creation offers Smart, Mid, Cheap, and a custom name. Templates start as local empty drafts; saving requires at least one configured member. Do not invent models, accounts, or credentials to populate them.

The first release uses **ordered failover**, up to 100 members. Existing round-robin/usage-aware router configurations retain their old semantics; this plan does not remove or silently change them. Pool members may reuse an account with different harness/model settings, but exact duplicate member configurations are rejected.

Healthy work stays pinned to its member. Confirmed quota/authentication/definitive stopped-runner failures use the existing bounded, receipted continuation path. Provider reset time wins; otherwise account quota/authentication holds are two hours and definitive runner failures five minutes. In V2, quota/authentication holds share the existing credential/epoch identity; a runner failure instead uses a versioned key for credential + concrete harness + environment. A broken Claude process must not mark an otherwise usable Codex execution unavailable merely because it uses the same gateway credential. Reuse the existing cooldown table with opaque versioned keys, and keep legacy key interpretation unchanged. Exhaustion waits for the earliest eligible deadline or a real configuration/reconnect event. Do not add idle polling or retry an unavailable account on every dispatch.

Runs show both **Pool: Smart** and the **actual harness/model/account used**, plus a concise transition/wait reason. Historical runs retain their original values after pool edits or renames. Editing a pool does not rewrite active work. Disabling/archive prevents new allocations without destroying settlement/recovery evidence; show affected agents before archive.

Switching harnesses starts a new provider conversation with the existing authorized, bounded task handoff and preserved workspace. Provider-private session state is not portable. Completed actions are references, not tool requests to replay; known unfinished mutations remain held. Generic task/model errors do not trigger a cheaper/more expensive model switch.

## 3. Ownership and data contract

### Pool intent versus concrete execution

Pool is a product-level harness choice, not a new native protocol provider. Keep `agent.adapterType = paperclip_runner` for newly bound Pool agents. Add a typed optional `runtimeConfig.harnessPool = { poolId: UUID }`; absence retains direct behavior. Reject simultaneous `harnessPool` and the legacy `aiConnection.mode = router` binding. The agent's stored fallback/provider config is inactive while Pool is selected and must never be used after a pool admission failure.

Require an explicit Save/upgrade workflow to move an existing legacy agent to native Pool execution. Preserve its previous direct configuration for an explicit switch back; do not silently upgrade all agents during deployment.

### Versioned members

Add `HarnessPoolConfigV2` and `HarnessPoolMemberV2` in `packages/shared/src/harness-pools.ts`:

```ts
type HarnessPoolMemberV2 = {
  id: string;
  harness: { type: "claude_code" | "codex" | "grok" | "opencode" };
  connection: AiConnectionBinding; // explicit authorized grant; no responsible_user shortcut
  model: string;
  effort?: string;
};
type HarnessPoolConfigV2 = {
  schemaVersion: 2;
  kind: "harness_pool";
  name: string;
  enabled: boolean;
  mode: "failover";
  members: HarnessPoolMemberV2[];
};
```

The first release deliberately shares the agent's instructions, tool permissions, environment and sandbox policy across members. It supports the member settings above, not arbitrary shell commands, custom wrappers, independent workspaces, or per-member permission expansion. Harness-to-driver mapping belongs in the host resolver, using existing provider-profile builders.

Reuse `ai_connection_pools` JSON config with a V1/V2 discriminated decoder, existing cursor/pin tables, and company-scoped cooldowns. Do not create a parallel `harness_pools` database table. Update Drizzle JSON types without rewriting historical snapshots. Generate a database migration only if an actual SQL constraint/index change is necessary; renumber against the live upstream base at implementation time.

Add a host-authored `HarnessPoolExecutionSelection` snapshot with `schemaVersion: 2`, `poolId`, `poolRevision`, `memberId`, `memberSnapshot: HarnessPoolMemberV2`, and `fingerprint: string`. The already-existing native Runner profile stores the matching concrete driver profile; the member snapshot contains safe account references and model/effort. Freeze both before the native execution claim. Retain captured credential identity/epoch in the existing protected host admission record, not plaintext credentials in context/logs. A current pool revision must never replace that admitted selection in place.

### Admission and compatibility

`resolveHarnessPoolExecution(input): Promise<HarnessPoolAdmission>` consumes company/agent/run/task identity, responsible user, pool binding, effective agent policy and existing pin. Define `HarnessPoolAdmission` in the owning server module as `{ kind: "selected"; selection: HarnessPoolExecutionSelection; profile: PaperclipRunnerProviderProfile } | { kind: "waiting"; retryAt: Date; reasons: Record<string, string> } | { kind: "unavailable"; code: string; reason: string }`. `PaperclipRunnerProviderProfile` is the existing type exported by `native-runtime/provider-profile.ts`; it does not move into shared contracts. Reuse the existing authorized router and cooldown store underneath; do not duplicate their transaction/lock policy.

Resolve before capability/tool preparation and before claim, then revalidate current authority at dispatch. Use only the selected concrete harness capabilities; filter candidates against required task features and execution policy. Do not advertise every capability supplied by any pool member. Reuse and test current task model/effort override handling, including explicit fallback notes; never pass a source harness's model ID or unsupported permission flags blindly to another driver.

The native Runner receives its existing concrete Codex/ACPX/OpenCode profile. There is one process/session owner and one authoritative run/finalization per attempt. Pool intent and the admitted child profile are both retained for audit. A safe failover creates one linked successor, rather than silently replacing the harness of a running claim.

## 4. Compatibility and delivery boundaries

- Keep V1 decoders and old pool endpoints working. New `/companies/:companyId/harness-pools` endpoints are a facade over the same built-in pool records and revisions, not a second state owner.
- Do not convert plugin-owned routers into built-in harness pools. Their capability and proposal contract remains unchanged.
- Offer explicit conversion of an existing built-in pool after a preview. Preserve its ID and order, normalize known V1 profiles to V2 members, and retain old pins for historical readers. Native agent upgrade is a separate explicit operation.
- Already queued/claimed V1 work continues under its old snapshot. Converting a pool or selecting a different pool on an agent cannot amend an in-flight native admission. Recheck current access for subsequent execution.
- Stop and cooldown continue to share existing transaction/lease owners. A removed or rebound member can still contribute a verified historical cooldown; it cannot authorize a new start under stale access.
- Proxy connections remain existing gateway connections. A gateway's internal selected upstream account is not observable unless a separately qualified attribution contract supplies it. Do not report that hidden account or treat proxy-managed cooldown as a Paperclip-owned credential cooldown.
- Application rollback must still read V2 configuration. Turning the feature off blocks fresh Pool admissions but must retain existing run settlement and reconciliation; downgrading to a V1-only binary after creating V2 records is not a safe rollback.

## 5. File structure and tasks

### Task 1: Versioned pool contracts and compatible persistence

**Files:** Create `packages/shared/src/harness-pools.ts` and `packages/shared/src/harness-pools.test.ts`; modify `packages/shared/src/ai-connection-router.ts`, `packages/shared/src/validators/agent.ts`, `packages/shared/src/index.ts`, and `packages/db/src/schema/ai_connection_routing.ts`.

**Interfaces:** Export `HarnessPoolMemberV2`, `HarnessPoolConfigV2`, `HarnessPoolBinding`, `HarnessPoolExecutionSelection`, and `decodeHarnessPoolConfig(raw)` with separate V1/V2 results. V1 public type consumers and plugin requests retain their existing shape.

- [ ] Write failing tests for V1 round trips, V2 member normalization, the 100-member boundary, exact duplicates, two different models on the same grant, and conflicting agent bindings.
- [ ] Implement strict V2 validation and immutable native-profile conversion helpers; leave model IDs catalog-driven. Update JSON types through a backwards-readable union.
- [ ] Run `pnpm exec vitest run packages/shared/src/harness-pools.test.ts` and affected shared typechecks; assert zero runtime reinterpretation of old snapshots.
- [ ] Commit only contracts, persistence typing and their tests. Update `doc/DATABASE.md` if persistence behavior or SQL changes.

### Task 2: One central management service and API

**Files:** Modify `server/src/services/ai-connection-router.ts`, `server/src/routes/ai-connections.ts`, and `server/src/__tests__/ai-connection-router.test.ts`; create `server/src/__tests__/harness-pools.test.ts`.

**Interfaces:** Add `harnessPools.list/save/inspect/archive/convertV1`, reusing the existing pool service/storage; expose GET/POST `/companies/:companyId/harness-pools`, GET `/:poolId/inspection`, POST `/:poolId/convert`, and DELETE `/:poolId` with `expectedRevision`.

- [ ] Write failing API tests for cross-company access, management permissions, stale revisions, shared versus personal grants, archive references, and forbidden plugin-router conversion.
- [ ] Implement management with existing guards/activity logging and one canonical revision. Add duplicate-account/different-model eligibility while preserving shared credential cooldown.
- [ ] Add conversion preview/commit tests preserving ID/order and old pin snapshots; verify V1 clients continue to read compatible V1 pools without receiving undecodable V2 records.
- [ ] Run `pnpm exec vitest run server/src/__tests__/harness-pools.test.ts server/src/__tests__/ai-connection-router.test.ts`; commit this service/API slice.

### Task 3: Resolve the virtual Pool harness through normal native admission

**Files:** Create `server/src/services/heartbeat/harness-pool-admission.ts` and its focused test; modify `heartbeat/effective-run-adapter.ts`, `heartbeat/run-preparation.ts`, `heartbeat/runtime-selection.ts`, `heartbeat/execution-configuration.ts`, `server/src/routes/agents.ts`, and the existing provider-profile mapping only where needed.

**Interfaces:** Implement `resolveHarnessPoolExecution(input): Promise<HarnessPoolAdmission>` as specified in section 3, plus a pure `effectivePoolExecutionAgent(run, agent)` reader of the frozen host selection. Keep legacy `preparePoolAdapterClaim` as a compatibility entry point until its callers are migrated.

- [ ] Write failing assembled admission tests: Harness=Pool resolves Claude/Codex targets, freezes before tools/claim, never falls back to inactive primary settings, and does not mutate the saved agent.
- [ ] Cover native feature disabled, unavailable environments, unsupported tool/image/policy requirements, revoked grants, stale claim revisions, and a taskless run's durable affinity.
- [ ] Wire the resolver into existing native admission and existing concrete provider builders. Preserve required instructions/tool delivery and driver capabilities. Do not implement a Rust Pool provider or another agent loop.
- [ ] Run the new admission tests and relevant runtime-selection/queue tests. Verify direct and legacy routing remain unchanged; commit the execution slice.

### Task 4: Reuse failover, sessions, cooldowns and restart recovery

**Files:** Modify `heartbeat/pool-failover.ts`, `heartbeat/retries.ts`, `heartbeat/run-completion.ts`, `heartbeat/run-control.ts`, `native-runtime/native-safe-replacement.ts`, `native-runtime/native-quota-wake.ts`, and their existing focused regression tests.

**Interfaces:** Native V2 selections and old V1 selections are normalized at existing retry/attribution boundaries. Add `harnessPoolCooldownKey(kind, credentialIdentity, harnessType, environmentId)` in the cooldown owner: quota/auth use the existing key; V2 runner faults use a collision-safe, versioned encoding of the three scoped values. The existing source/successor lock owner remains responsible for the atomic pin transition and one linked successor.

- [ ] Add failing tests for two agents sharing a credential cooldown, two models sharing account exhaustion, a runner failure leaving another harness/environment eligible, five ordered members, all members cooling, reconnecting a different backup, restart reconstruction, and one successor under concurrent completion/retry.
- [ ] Add pool-edit/rename/removal cases proving historical attribution, current authorization and exact session/profile identity remain separate. Pin changes must never follow mutable model equality alone.
- [ ] Exercise Stop before/after successor admission, budget pause, reassignment, required workspace cleanup, pending approval and uncertain external actions. Pair completed tool receipts without automatically replaying them.
- [ ] Implement V2 normalization using existing settlement/receipts and deadline notifications. Same compatible member resumes; incompatible target uses the bounded fresh-context handoff. Preserve current failure classification and attempt bounds.
- [ ] Run the affected retry/control/native suites, including the joined `native-provider-capacity.integration.test.ts`; commit after the observable lifecycle tests pass.

### Task 5: Central pools UI and independent agent choices

**Files:** Create `ui/src/pages/HarnessPools.tsx`, `ui/src/api/harness-pools.ts`, `ui/src/components/harness-pools/HarnessPoolEditor.tsx`, and focused tests. Modify `ui/src/components/AgentConfigForm.tsx`, `ui/src/pages/AgentDetail.tsx`, `ui/src/components/ai-connections/AiConnectionPoolConnector.tsx`, `ui/src/components/ai-connections/AiConnectionPoolRunDetails.tsx`, `ui/src/App.tsx`, and the existing company settings/navigation and query-key owners located during implementation.

**Interfaces:** `harnessPoolsApi` matches Task 2; agent binding uses `runtimeConfig.harnessPool`. Run detail reads Task 3's admitted selection rather than the latest central config.

- [ ] Write failing component tests for Pool selection, Smart/Mid/Cheap drafts, ordered member editing, explicit save/conversion, optimistic revision conflicts, and management permissions.
- [ ] Separate Runner from Harness in the form. Remove Paperclip Runner as an ordinary harness option; preserve direct-harness and existing upgrade behavior. Show Pool only when native execution is available, with the actual unavailable reason otherwise.
- [ ] Reuse member/account picker components. Show model and effort per member, actual selected member per run, and truthful waiting/error states. Do not show a misleading primary model/account for Pool agents.
- [ ] Verify load/error/empty/ready/revoked states, keyboard selection, no unauthorized account disclosure, and history after central edits. Run focused UI tests, UI typecheck, and `pnpm check:token-gates`; commit the UI slice.

### Task 6: Product acceptance and failure accounting

**Files:** Extend `server/src/services/native-runtime/native-provider-capacity.integration.test.ts`; add the appropriate public-path tests under `tests/runner-e2e/` following its existing harness/fixtures. Update `doc/connections/AI-CONNECTION-ROUTERS.md`, `doc/DEVELOPING.md`, the applicable entries in `maps/feature-map/agents.md`, `maps/feature-map/connection-setup.md` and `maps/agent-access-map/connection-setup.md`, and the release acceptance ledger. Record the substantial new central-management capability through the existing map contract rather than claiming map checks prove the journey.

- [ ] Prove two agents select one shared Smart pool, then one agent selects Mid without changing the other. Verify company isolation and management through the actual UI/API.
- [ ] On Windows and Linux, exercise real concrete provider startup and independently verify a workspace output. Qualify same-harness account failover and Claude-to-Codex continuation with controlled quota/auth/runner faults, retained task intent, and no known mutation replay. Use authorized connected accounts; retain spend and outcome evidence.
- [ ] Exercise Stop during real pending work, disconnected controller/restart, unavailable proxy member if included, and all members unavailable. Do not equate an injected containment fixture with physical cleanup proof or green helper tests with a live subscription handoff.
- [ ] Run smallest tests first, then required final `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build` on a supported environment. Keep Windows operational qualification separate from Linux full checks. Run token gates and `node scripts/check-maps.mjs` for map changes. Retain original failures and the exact narrower scope of any successful rerun.
- [ ] Account for the current PR's known full-Windows command/fixture failures and stopped broad local recovery run. Reproduce and classify relevant residual failures; do not relabel them passed or drop them from the ledger.
- [ ] Commit docs/evidence references and acceptance tests. Do not claim release completion while promised cross-harness behavior remains unqualified.

### Task 7: Rework the existing PR and integrate safely

**Baseline:** Live PR `https://github.com/paperclipai/paperclip/pull/19481`, ready/open at `319ed0c5e0` against upstream `master` when inspected on 2026-11-07. Local develop already contains the previous implementation at merge `70fb4048d3`. These are observations, not fixed future base refs.

- [ ] At implementation start, fetch/inspect live upstream, PR head/review state, local worktrees and dirty files. Use the existing isolated upstream feature branch or another isolated continuation branch without unrelated fork commits. Read applicable rules/skills before changing each scope.
- [ ] Refactor additive host selection and UI contracts around the existing PR. Retain old readers and legacy recovery; remove duplicate new paths only after replacement coverage proves parity. Do not rewrite published branch history or force-push others' contributions.
- [ ] Conduct the required independent review and scoped fixes; verify the immutable candidate. Update the existing PR title/body using every template section, clearly describing Pool versus proxy and the exact qualified matrix. Keep it ready for review; do not restart a watcher or open a PR to the user's own repo.
- [ ] After verification, port only feature changes into an isolated branch based on the then-current local develop. Inspect literal conflicts, retain local compatible behavior, and rerun the joined tests against that exact port.
- [ ] Merge directly into local develop as already requested, preserving dirty files. Restart the local server through the supported handoff path and verify owner, version, health and UI. Do not merge upstream until its own review/check requirements are met.

## 6. Acceptance and self-review

The plan is complete when every selected native Pool run has one frozen concrete target; central management and per-agent choice work; supported failures advance safely; all-cooling work waits; and Stop/current authority remain effective across restart and concurrent transitions. Direct and historical legacy behavior must remain readable and operable.

Self-review mapping: central configuration/Smart-Mid-Cheap and same-account model diversity -> Tasks 1/2/5; exact native child admission/capabilities -> Task 3; historical edits/shared cooldown/Stop/uncertain actions -> Task 4; physical and product evidence -> Task 6; PR/develop/dirty-work preservation -> Task 7. The proxy alternative is explicitly separated and does not become an unbounded second implementation project.

This file is a plan only. No production source, pool, agent binding, PR content, runtime process, or provider account was changed while writing it.

## Implementation status — 2026-11-08

Tasks 1–5 are implemented on the existing upstream feature branch and ported to
local develop for early testing. The existing PR remains ready for review:
https://github.com/paperclipai/paperclip/pull/19481. No fork PR or watcher is needed.
Subsequent review fixes are verified and integrated separately; this status is not
an assertion that every acceptance checkbox above has passed.

The Linux typecheck/build and a real Rust Runner with a controlled fake Codex
app-server passed. Focused tests cover central management, agent choices, frozen
admission, shared/scoped cooldowns and safe successors. These controlled tests do
not qualify real subscription handoff or physical Stop/restart behavior.

Follow-up verification on local develop `8f65a13dc0` corrects the earlier blanket
Windows limitation: the native Codex server vertical slice passes on Windows with
the real Rust Runner and a controlled provider (1/1), including durable completion
and session resume. Native Codex Stop tests pass 2/2; portable recovery tests pass
5/5, including restarting the provider without repeating its completed turn. The
Unix-only interrupted-startup case executes zero tests on Windows and is not proof.
These results do not qualify every managed provider profile or a live subscription.

The browser extension now works. Central pool save, member ordering, reload, and
refusal of a disabled pool are verified. The real new-agent journey exposed a
background verification path that ignored `runtimeConfig.harnessPool`; its fix uses
the shared effective binding reader and the existing managed account probe. The
new regressions prove that the selected member is tested and a revoked account
cannot fall back to ambient credentials. The full preflight file passes 11/11.

Task 6 remains open for the live-account journey, physical controller-crash
continuation, and any selected SSH/sandbox qualification. Full upstream CI passed
on `aefc630f4a`; follow-up commits require their own checks. Earlier failures retain
their original evidence. Do not describe this plan as fully completed while the
selected acceptance gates are open. Local develop integration remains authorized.

Follow-up review fixes keep lifecycle verification on the same selected-member
settings and execution-policy guard as task admission. Pool cooldown failures
retain their actual retry deadline in the existing lifecycle operation, without
spending verification failures. Account/pool producer transactions recheck affected
verifications through the lifecycle module's existing transactional wake contract;
rollback and an update arriving during defer cannot lose that wake. The existing
scheduler reconstructs the saved deadline after restart. No new polling loop or
parallel lifecycle store is introduced.
