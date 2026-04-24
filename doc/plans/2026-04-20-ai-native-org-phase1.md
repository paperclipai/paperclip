# AI-Native Org Phase 1 Implementation Plan

> **For Hermes:** execute this on branch `feat/ai-native-org-phase1` using strict TDD for every behavior change.

**Goal:** Ship an overnight-credible Phase 1 that makes Paperclip feel AI-native without rewriting the platform: board-gated hiring UX, supervisor-aware orchestration scaffolding, non-blocking approvals plumbing, proactive work selection defaults, org-wide capability inheritance, and private-vs-shared plugin memory policy.

**Architecture:** Reuse existing approvals, agent-hire, plugin state, and capability-validator primitives. Add the smallest possible policy layer in shared types + server services, then tighten UI around the already-existing hire approval flow. Defer full org workflow builders, multi-stage approver routing, and generalized memory products.

**Tech Stack:** TypeScript, pnpm monorepo, Express server, Drizzle ORM, Vitest, React.

---

## What was already confirmed before implementation

- Working branch exists: `feat/ai-native-org-phase1`
- Existing hire approval path already exists via `POST /api/companies/:companyId/agent-hires`
- Approval UI already exists in `ui/src/pages/Approvals.tsx` and `ui/src/pages/ApprovalDetail.tsx`
- Plugin state and capability enforcement already exist in:
  - `server/src/services/plugin-state-store.ts`
  - `server/src/services/plugin-capability-validator.ts`
  - `server/src/app.ts`
  - `packages/shared/src/constants.ts`
  - `packages/shared/src/validators/plugin.ts`
  - `packages/db/src/schema/plugin_company_settings.ts`

## Must-build overnight scope

### Ship
1. Better new-agent approval UX when `requireBoardApprovalForNewAgents` is enabled.
2. Response/path consistency for agent hires so UI can branch cleanly.
3. Minimal supervisor/proactive scaffolding using existing agent fields and orchestration primitives, without inventing a workflow engine.
4. Company/plugin policy model for:
   - org-wide capability inheritance
   - plugin memory privacy/share scope enforcement
5. Tests for all above.

### Explicitly defer
- Full human+AI employee unification across every data model.
- Multi-step approval chains / workflow builder.
- Rich manager hierarchy UI.
- New standalone memory subsystem.
- Policy authoring UI beyond tiny existing settings hooks.

---

## Feature mapping to requested Phase 1 themes

### 1) Human + AI employee model refinement
Overnight interpretation: do not redesign the org model. Instead, make hire approvals + supervisor metadata coherent for agents so they participate more like org members.

### 2) Supervisor orchestration
Overnight interpretation: add/normalize supervisor metadata and use it for orchestration defaults and display, not a new orchestration engine.

### 3) Non-blocking approvals
Overnight interpretation: preserve the existing pending-approval agent creation path and improve UX + response shapes so creation is asynchronous and obvious.

### 4) Proactive work selection
Overnight interpretation: allow agent/supervisor metadata and company policy defaults to bias autonomous work selection using existing orchestration points, not a full planner rewrite.

### 5) Org-wide capability inheritance
Implement as policy intersection: `manifest.capabilities ∩ company policy grants`.

### 6) Private vs shared memory policy
Implement as host-enforced allowed/disallowed plugin-state scopes plus reserved namespaces.

---

## Concrete implementation slices

### Slice A — Hire approval UX polish and consistency

**Objective:** Make the existing board-gated hire flow understandable and reliable.

**Files to inspect/update:**
- `server/src/routes/agents.ts`
- `server/src/services/approvals.ts`
- `packages/shared/src/validators/agent.ts`
- `ui/src/pages/NewAgent.tsx`
- `ui/src/api/agents.ts` or the actual agent API wrapper file in UI
- Existing tests around agent hire routes/UI

**Target behavior:**
- If `selectedCompany.requireBoardApprovalForNewAgents === true`:
  - the submit CTA says “Submit for approval”
  - the helper copy says the hire will remain pending until approved
  - success navigates to the created approval detail when an approval object is returned
- If approval is not required:
  - existing direct create UX remains intact

**Tests to add first:**
- Server route test verifying `/agent-hires` returns stable `{ agent, approval }` semantics.
- UI test verifying `NewAgent` button/copy changes when company requires approval.
- UI test verifying navigation/toast behavior when response includes an approval.

---

### Slice B — Minimal supervisor + proactive defaults

**Objective:** Add the narrowest data/control path needed so agents can carry supervisor/orchestration hints without schema sprawl.

**Files to inspect/update:**
- `packages/shared/src/validators/agent.ts`
- `packages/shared/src/types/*agent*`
- `server/src/routes/agents.ts`
- `server/src/services/agents.ts`
- `ui/src/pages/NewAgent.tsx`
- any runtime config helpers such as `ui/src/lib/new-agent-runtime-config.ts`

**Recommended shape:**
- Reuse existing fields if already present for `reportsToAgentId`, manager/supervisor, or goal ownership.
- If missing, add only one optional field for supervisor linkage and one optional field for proactive/autonomous posture in existing config JSON rather than adding multiple new tables.

**Preferred data shape (if needed):**
```ts
orchestration?: {
  supervisorAgentId?: string;
  workMode?: "reactive" | "proactive";
  approvalMode?: "blocking" | "non_blocking";
}
```

**Rule:** put this in existing config/payload structures if possible. Do not create a new orchestration schema unless absolutely required by current code layout.

**Tests to add first:**
- validator test for allowed orchestration config shape.
- route/service test showing orchestration hints survive create/hire flow.

---

### Slice C — Plugin memory privacy/share policy

**Objective:** Enforce private vs shared memory using current `plugin_state` primitives.

**Files to update:**
- `packages/shared/src/constants.ts`
- `packages/shared/src/validators/plugin.ts`
- `packages/shared/src/types/plugin.ts`
- `server/src/services/plugin-state-store.ts`
- optionally a small helper file in `server/src/services/` for plugin policy resolution
- tests under `server/src/__tests__/`

**Recommended reserved namespaces:**
- `paperclip.memory`
- `paperclip.capabilities`

**Recommended company settings JSON shape:**
```ts
interface PluginCompanySettingsJson {
  memoryPolicy?: {
    defaultVisibility?: "private" | "shared";
    allowSharedScopes?: PluginStateScopeKind[];
    denyScopes?: PluginStateScopeKind[];
    namespacePolicies?: Record<string, {
      visibility?: "private" | "shared";
      allowedScopes?: PluginStateScopeKind[];
      deniedScopes?: PluginStateScopeKind[];
    }>;
  };
  capabilityPolicy?: {
    mode?: "inherit" | "override";
    grants?: Partial<Record<PluginCapability, boolean>>;
  };
}
```

**Enforcement point:**
- `pluginStateStore` must reject writes/reads/lists to disallowed scopes for company-scoped policies.

**Practical overnight default:**
- allow: `company`, `project`, `issue`, `goal`, `run`
- restrict unless explicitly allowed: `instance`, `agent`
- keep `project_workspace` allowed only if current plugin usage needs it; otherwise treat as shared and allow via policy

**Tests to add first:**
- `pluginStateStore` allows normal company scope writes with no restrictive policy.
- `pluginStateStore` rejects denied scope writes.
- `pluginStateStore` rejects broad list operations when policy forbids that scope.

---

### Slice D — Org-wide capability inheritance

**Objective:** Make company policy narrow plugin capabilities at runtime without changing plugin manifests.

**Files to update:**
- `server/src/services/plugin-capability-validator.ts`
- `server/src/app.ts`
- maybe `server/src/services/plugin-loader.ts` or host service builder if that’s where company context is easiest to resolve
- shared plugin settings typing if needed
- tests under `server/src/__tests__/`

**Rule:**
- manifests declare the max possible capabilities
- company policy narrows them
- effective capabilities are passed into `createHostClientHandlers`

**Recommended helper:**
```ts
resolveEffectiveCapabilities(
  manifest: PaperclipPluginManifestV1,
  policy?: { grants?: Partial<Record<PluginCapability, boolean>> }
): PluginCapability[]
```

**Runtime rule:**
```ts
effective = manifest.capabilities.filter((cap) => policy grants cap !== false)
```
More precisely, if `grants` is present, only explicit `true` values survive in strict mode; otherwise preserve current behavior for backward compatibility.

**Tests to add first:**
- validator returns raw manifest caps when no policy exists.
- validator returns intersection when policy exists.
- host handler creation receives effective capabilities, not raw manifest caps.

---

## Recommended implementation order

### Task 1: Lock the hire approval contract with tests
**Objective:** Capture current behavior and the intended stable response shape before editing UI.

**Files:**
- Test: existing server test file covering `/api/companies/:companyId/agent-hires` (likely `server/src/__tests__/agent-skills-routes.test.ts`)
- Modify: `server/src/routes/agents.ts` only if tests expose inconsistent response shape

**Step 1: Write failing server tests**
Add tests for:
- approval-required flow returns `approval` object and `agent.status === "pending_approval"`
- approval-not-required flow returns `approval: null` and active/idle agent

**Step 2: Run targeted tests**
Run:
```bash
pnpm vitest run server/src/__tests__/agent-skills-routes.test.ts
```

**Step 3: Make minimal server changes**
Only normalize response shape if necessary.

**Step 4: Re-run targeted tests**
Same command.

---

### Task 2: Add failing UI tests for New Agent approval UX
**Objective:** Force the UI to expose approval mode clearly.

**Files:**
- Test: `ui/src/pages/NewAgent.test.tsx` if it exists, otherwise create it
- Modify later: `ui/src/pages/NewAgent.tsx`

**Tests:**
- company requiring approval shows “Submit for approval”
- success with returned approval navigates to approval detail

**Run:**
```bash
pnpm vitest run ui/src/pages/NewAgent.test.tsx
```

---

### Task 3: Implement the minimal New Agent UX
**Objective:** Make the board-gated flow feel intentional.

**Files:**
- `ui/src/pages/NewAgent.tsx`
- any related API/types helper used by the page

**Changes:**
- branch CTA copy on company setting
- branch helper copy on company setting
- on successful create/hire, if `result.approval?.id` exists, navigate to `/approvals/:id`; else go to agent detail as today

**Run:**
```bash
pnpm vitest run ui/src/pages/NewAgent.test.tsx
```

---

### Task 4: Add failing tests for plugin memory policy enforcement
**Objective:** Create the safety rails before touching `plugin-state-store`.

**Files:**
- Create/modify: `server/src/__tests__/plugin-state-store.test.ts` or nearest existing plugin state service test file
- Modify later: `server/src/services/plugin-state-store.ts`

**Tests:**
- denied `agent` scope write throws
- allowed `company` scope write succeeds
- denied scope list throws or filters according to chosen contract (prefer throw for simplicity)

**Run:**
```bash
pnpm vitest run server/src/__tests__/plugin-state-store.test.ts
```

---

### Task 5: Implement memory policy helper and enforcement
**Objective:** Enforce memory privacy/share policy centrally.

**Files:**
- `server/src/services/plugin-state-store.ts`
- maybe new helper: `server/src/services/plugin-policy.ts`
- shared type additions in `packages/shared/src/types/plugin.ts` or validators if needed

**Minimal implementation approach:**
- add helper to resolve company policy for the plugin
- add `assertScopeAllowed(...)` called by `get`, `set`, `delete`, and scoped `list`
- if company context is not yet available in the store, thread it through the state service constructor in the narrowest way possible

**Note:** if `pluginStateStore` currently lacks company context, the overnight-safe move is to pass an optional policy resolver function into the store instead of redesigning all callers.

---

### Task 6: Add failing tests for capability inheritance
**Objective:** Prove runtime capability narrowing before changing handler wiring.

**Files:**
- existing validator tests or create: `server/src/__tests__/plugin-capability-validator.test.ts`
- optionally host wiring tests near plugin SDK bridge tests

**Tests:**
- `resolveEffectiveCapabilities` with no policy returns manifest caps
- with policy grants subset returns subset
- denied capability is not present in effective list

**Run:**
```bash
pnpm vitest run server/src/__tests__/plugin-capability-validator.test.ts
```

---

### Task 7: Implement capability inheritance and wire host handlers
**Objective:** Pass effective capabilities into runtime handlers.

**Files:**
- `server/src/services/plugin-capability-validator.ts`
- `server/src/app.ts`
- maybe plugin settings lookup helper/service

**Changes:**
- add `resolveEffectiveCapabilities`
- in app host handler builder, compute effective capabilities before calling `createHostClientHandlers`
- preserve existing behavior when no company/plugin policy exists

---

### Task 8: Minimal supervisor/proactive hints
**Objective:** Add only enough structure to store and propagate supervisor/proactive behavior.

**Files:**
- agent shared validator/type files
- `server/src/routes/agents.ts`
- `ui/src/pages/NewAgent.tsx`
- any agent config helper touched by create flow

**Changes:**
- use optional config payload for `supervisorAgentId`, `workMode`, `approvalMode`
- persist via existing agent config/metadata path
- show/control this only if the page already has a reasonable place for it; otherwise support it in API first and keep UI minimal

**Guardrail:** if this slice starts expanding, cut it back. It is the least important overnight item after approvals + plugin policy.

---

### Task 9: Full verification
**Objective:** Make sure the monorepo still stands up.

**Run:**
```bash
pnpm vitest run server/src/__tests__/agent-skills-routes.test.ts
pnpm vitest run server/src/__tests__/plugin-state-store.test.ts
pnpm vitest run server/src/__tests__/plugin-capability-validator.test.ts
pnpm vitest run ui/src/pages/NewAgent.test.tsx
pnpm typecheck
pnpm build
```

If failures appear, fix only regressions caused by this branch.

---

## Acceptance criteria for the morning

### Approval UX
- New Agent clearly switches into approval-submission mode when company policy requires it.
- Successful gated hires route to an approval page or clearly surface pending approval.
- `/agent-hires` response shape is stable enough for UI branching.

### Capability inheritance
- Runtime plugin capabilities can be narrowed by company policy.
- No-policy behavior remains backward compatible.

### Memory policy
- Plugin state writes/reads/lists respect company memory policy.
- Private-vs-shared behavior is enforced through scope restrictions, not plugin honesty.

### Supervisor/proactive scaffolding
- At least one narrow, persisted orchestration hint exists and is tested.
- No big workflow-engine detour happened.

---

## Risks / traps to avoid

1. Do not build a general approval workflow engine tonight.
2. Do not add new tables for memory unless absolutely forced by existing architecture.
3. Do not overfit UI around speculative org hierarchy features.
4. If company context for plugin policy is hard to plumb into every runtime path, prefer a conservative default and explicit helper injection rather than a wide rewrite.
5. Keep all behavior behind existing company/plugin settings where possible.

---

## Commit strategy

Recommended commit boundaries:
1. `test: lock hire approval response semantics`
2. `feat: polish new agent approval UX`
3. `test: cover plugin memory policy enforcement`
4. `feat: enforce plugin memory scope policy`
5. `test: cover plugin capability inheritance`
6. `feat: apply effective plugin capabilities at runtime`
7. `feat: add minimal supervisor orchestration hints`
8. `chore: typecheck and build fixes`

---

## Morning handoff checklist

- [ ] Branch contains all code changes on `feat/ai-native-org-phase1`
- [ ] Targeted Vitest suites pass
- [ ] `pnpm typecheck` passes
- [ ] `pnpm build` passes
- [ ] Final summary includes what shipped vs what was deferred
