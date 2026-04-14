# Hermes Company Settings And Staff Profile Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add company-scoped Hermes defaults plus staff-scoped Hermes profile bindings so choosing `hermes_local` auto-suggests the right Hermes profile, auto-creates a managed profile when needed, and stops duplicating model/base-url/api-key settings across every staff member.

**Architecture:** Store Hermes defaults once per company in a new generic `company_adapter_settings` table keyed by `companyId + adapterType`, then keep the staff-to-Hermes mapping in each agent's `adapterConfig.hermesProfile` block so the association survives adapter switches. Add a server-side Hermes profile manager that resolves or materializes one Paperclip-managed Hermes home per staff member under the Paperclip instance root, writes profile-local Hermes config from company defaults, injects `HERMES_HOME` at runtime, and exposes a company/agent-aware suggestion API for the Hermes UI.

**Tech Stack:** TypeScript, Drizzle ORM, Express, React 19, TanStack Query, Vitest, Hermes CLI profile conventions, Paperclip company secrets.

---

## File Map

- Create: `packages/db/src/schema/company_adapter_settings.ts`
  Responsibility: persist adapter-wide company settings without polluting `companies`.
- Modify: `packages/db/src/schema/index.ts`
  Responsibility: export the new table.
- Generate: `packages/db/src/migrations/*company_adapter_settings*.sql`
  Responsibility: create the new table and indexes.
- Create: `packages/shared/src/types/company-adapter-settings.ts`
  Responsibility: shared Hermes company-settings and profile-suggestion contracts.
- Create: `packages/shared/src/validators/company-adapter-settings.ts`
  Responsibility: validate the new route payloads and Hermes settings shape.
- Modify: `packages/shared/src/index.ts`
  Responsibility: export the new shared types and validators.
- Create: `server/src/services/company-adapter-settings.ts`
  Responsibility: load, normalize, persist, and default company-scoped adapter settings.
- Create: `server/src/services/hermes-profile-manager.ts`
  Responsibility: derive profile suggestions, scan existing Hermes profiles, create managed profile homes, and build effective Hermes runtime config.
- Modify: `server/src/services/secrets.ts`
  Responsibility: expose a small reusable helper for validating and resolving company-secret references in company adapter settings without duplicating secret logic.
- Modify: `server/src/services/heartbeat.ts`
  Responsibility: inject resolved Hermes profile state and `HERMES_HOME` before execution.
- Modify: `server/src/home-paths.ts`
  Responsibility: resolve Paperclip-managed Hermes profile-home paths under the instance root.
- Modify: `server/src/routes/companies.ts`
  Responsibility: add company-scoped adapter-settings endpoints for Hermes defaults.
- Modify: `server/src/routes/agents.ts`
  Responsibility: add Hermes profile-suggestion endpoint and apply Hermes runtime resolution in adapter environment testing.
- Modify: `server/src/services/company-portability.ts`
  Responsibility: decide and implement how Hermes company settings travel through export/import without leaking secret ids blindly.
- Create: `server/src/__tests__/company-adapter-settings-routes.test.ts`
  Responsibility: lock API behavior for Hermes company settings.
- Create: `server/src/__tests__/hermes-profile-manager.test.ts`
  Responsibility: lock suggestion, path, scan, and runtime-resolution behavior.
- Modify: `server/src/__tests__/heartbeat-workspace-session.test.ts`
  Responsibility: extend Hermes runtime assertions for `HERMES_HOME` and timeout handling.
- Modify: `server/src/__tests__/agent-adapter-validation-routes.test.ts`
  Responsibility: cover the new company/agent-aware Hermes suggestion route.
- Create: `ui/src/api/companyAdapterSettings.ts`
  Responsibility: fetch and save company-scoped Hermes settings.
- Modify: `ui/src/api/agents.ts`
  Responsibility: add Hermes profile-suggestion client methods.
- Modify: `ui/src/lib/queryKeys.ts`
  Responsibility: cache company adapter settings and Hermes suggestion queries.
- Modify: `ui/src/pages/CompanySettings.tsx`
  Responsibility: add the Hermes defaults section to company settings.
- Modify: `ui/src/pages/CompanySettings.test.tsx`
  Responsibility: lock Hermes company-settings save behavior.
- Modify: `ui/src/adapters/hermes-local/index.ts`
  Responsibility: stop using the generic schema-driven Hermes form and route Hermes to a company-aware custom form.
- Modify: `ui/src/adapters/hermes-local/config-fields.tsx`
  Responsibility: show suggested profile state, let the operator accept managed creation or link an existing profile, and explain the effective company defaults.
- Create: `ui/src/adapters/hermes-local/config-fields.test.tsx`
  Responsibility: lock Hermes profile suggestion UX.
- Modify: `ui/src/components/AgentConfigForm.tsx`
  Responsibility: preserve `adapterConfig.hermesProfile` across adapter switches, skip generic Hermes model detection, and wire company-aware Hermes suggestions into create and edit flows.
- Modify: `ui/src/components/agent-config-defaults.ts`
  Responsibility: seed Hermes create-mode defaults cleanly.
- Modify: `ui/src/pages/NewAgent.tsx`
  Responsibility: pass the draft agent name into Hermes profile suggestion logic in create mode.
- Modify: `ui/src/adapters/hermes-local/index.test.ts`
  Responsibility: keep Hermes config-build defaults covered while adding profile-binding serialization.
- Modify: `doc/SPEC-implementation.md`
  Responsibility: record the new company-scoped Hermes settings and staff-profile mapping behavior if implementation changes the V1 operator contract.

## UX Decisions Locked In

- Company-level Hermes defaults belong in Paperclip, not in each agent config.
  Use one company-scoped settings record for `defaultModel`, `provider`, `baseUrl`, and `apiKeySecretId`.
- Staff-to-Hermes mapping belongs in `agent.adapterConfig.hermesProfile`.
  Persist it even when the agent later switches away from `hermes_local` by preserving that block during adapter-type changes.
- Paperclip-managed Hermes homes live under the Paperclip instance root, not under the user's global `~/.hermes`.
  Recommended managed path root: `~/.paperclip/instances/<instance>/data/hermes/profiles/<company-id>/<profile-name>`.
- Managed profile names are stable and human-readable.
  Suggested default: `<company.issuePrefix.toLowerCase()>-<agent.urlKey>`.
- `~/.hermes/profiles/*` remains a supported advanced source.
  If a matching external profile already exists, the UI can suggest linking it. If not, the UI should recommend creating the managed profile instead of making the operator type paths by hand.
- Hermes API keys must stay company-secret-backed.
  Do not persist raw API keys in agent configs. Resolve the company secret server-side when materializing the managed Hermes config.
- The generic `/api/adapters/:type/config-schema` route is the wrong place for Hermes staff suggestions.
  It is global-by-adapter, cached by type, and lacks company/agent context. Hermes needs a company-scoped suggestion endpoint instead.
- Hermes model detection should prefer Paperclip's stored company default.
  Do not let the generic Hermes detect-model flow overwrite a configured company default from `~/.hermes/config.yaml`.

## Behavior Contract

- `GET /api/companies/:companyId/adapter-settings/hermes_local`
  Returns an effective Hermes settings object even when no row exists yet. Missing rows should resolve to defaults instead of `404`.
- `PATCH /api/companies/:companyId/adapter-settings/hermes_local`
  Persists company-wide Hermes defaults after validating the referenced secret belongs to the same company.
- `GET /api/companies/:companyId/adapters/hermes_local/profile-suggestion`
  Accepts either `agentId=<uuid>` for edit mode or `agentName=<draft-name>` for create mode.
- Hermes suggestion response should include:
  - effective company Hermes defaults
  - suggested profile binding
  - whether a matching external profile already exists
  - whether a managed Paperclip profile already exists
  - the effective default model to prefill when the agent has no explicit Hermes model override
- Runtime rule for managed profiles:
  - resolve company Hermes defaults
  - resolve or create the managed Hermes home
  - write or refresh profile-local Hermes config
  - inject `env.HERMES_HOME`
  - preserve the existing Hermes timeout `0 -> -1` runtime patch
- Runtime rule for linked external profiles:
  - do not rewrite the external profile directory
  - only inject `env.HERMES_HOME` to the linked profile path
  - still allow an agent-level model override in `adapterConfig.model`

### Task 1: Lock The Company-Scoped Hermes Settings Contract

**Files:**
- Create: `server/src/__tests__/company-adapter-settings-routes.test.ts`
- Create: `packages/db/src/schema/company_adapter_settings.ts`
- Modify: `packages/db/src/schema/index.ts`
- Generate: `packages/db/src/migrations/*company_adapter_settings*.sql`
- Create: `packages/shared/src/types/company-adapter-settings.ts`
- Create: `packages/shared/src/validators/company-adapter-settings.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `server/src/services/company-adapter-settings.ts`
- Modify: `server/src/services/secrets.ts`
- Modify: `server/src/routes/companies.ts`

- [ ] **Step 1: Create the failing route test scaffold**

Mirror the route-test setup pattern from `server/src/__tests__/company-skills-routes.test.ts` or another company-scoped settings route so the new Hermes settings endpoints run against a real test app and test database.

- [ ] **Step 2: Write the failing default-read test**

Request:

```http
GET /api/companies/<companyId>/adapter-settings/hermes_local
```

Expected JSON shape:

```ts
{
  companyId: "<companyId>",
  adapterType: "hermes_local",
  settings: {
    provider: "custom",
    baseUrl: null,
    defaultModel: null,
    apiKeySecretId: null,
  },
}
```

The route should not return `404` just because no row exists yet.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test:run -- server/src/__tests__/company-adapter-settings-routes.test.ts`

Expected: FAIL because the route and table do not exist yet.

- [ ] **Step 4: Write the failing same-company-secret validation test**

Persist Hermes settings with a secret id from another company and assert the route rejects it with `422`.

This locks the invariant that Hermes API-key references cannot cross company boundaries.

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm test:run -- server/src/__tests__/company-adapter-settings-routes.test.ts`

Expected: FAIL because there is no validation or persistence yet.

- [ ] **Step 6: Implement the shared contract and persistence**

Create:

```ts
type HermesCompanySettings = {
  provider: string;
  baseUrl: string | null;
  defaultModel: string | null;
  apiKeySecretId: string | null;
};
```

Then:

- add the new `company_adapter_settings` table with `company_id`, `adapter_type`, `settings`, `created_at`, `updated_at`
- add a unique index on `company_id + adapter_type`
- add shared validators for the Hermes settings payload
- implement a company-adapter-settings service that returns effective defaults when the row is missing
- add `GET` and `PATCH` routes under `server/src/routes/companies.ts`
- expose a small reusable secret-resolution helper from `server/src/services/secrets.ts` so the route can validate `apiKeySecretId` cleanly

- [ ] **Step 7: Generate the migration and compile the DB package**

Run: `pnpm db:generate`

Expected: a new migration for `company_adapter_settings` is created and `packages/db` compiles cleanly.

- [ ] **Step 8: Re-run the targeted route test**

Run: `pnpm test:run -- server/src/__tests__/company-adapter-settings-routes.test.ts`

Expected: PASS.

- [ ] **Step 9: Run typecheck for the touched shared/server/db packages**

Run: `pnpm -r typecheck`

Expected: PASS with the new types, validators, and service exports wired correctly.

- [ ] **Step 10: Commit the contract work**

```bash
git add packages/db/src/schema/company_adapter_settings.ts packages/db/src/schema/index.ts packages/db/src/migrations packages/shared/src/types/company-adapter-settings.ts packages/shared/src/validators/company-adapter-settings.ts packages/shared/src/index.ts server/src/services/company-adapter-settings.ts server/src/services/secrets.ts server/src/routes/companies.ts server/src/__tests__/company-adapter-settings-routes.test.ts
git commit -m "feat: add company-scoped Hermes adapter settings"
```

### Task 2: Lock Hermes Profile Binding And Runtime Resolution

**Files:**
- Create: `server/src/services/hermes-profile-manager.ts`
- Create: `server/src/__tests__/hermes-profile-manager.test.ts`
- Modify: `server/src/home-paths.ts`
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/__tests__/heartbeat-workspace-session.test.ts`

- [ ] **Step 1: Write the failing managed-profile suggestion test**

In `server/src/__tests__/hermes-profile-manager.test.ts`, assert that an agent with:

```ts
{
  company: { issuePrefix: "LEB" },
  agent: { urlKey: "cmo-2" },
  adapterConfig: {},
}
```

receives a default Hermes binding shaped like:

```ts
{
  mode: "managed",
  profileName: "leb-cmo-2",
}
```

when there is no saved mapping and no matching external profile.

- [ ] **Step 2: Write the failing saved-binding precedence test**

Assert that if `adapterConfig.hermesProfile` already exists, the suggestion service returns that saved binding exactly instead of generating a new name from current agent labels.

This preserves staff mapping across renames and adapter switches.

- [ ] **Step 3: Write the failing external-profile match test**

Stub a matching directory under `~/.hermes/profiles/<profileName>` and assert the suggestion response marks it as an existing external candidate instead of pretending nothing exists.

- [ ] **Step 4: Write the failing runtime-config test**

Assert that resolving a managed Hermes runtime config:

- injects `env.HERMES_HOME`
- points it at the Paperclip-managed profile home
- keeps the Hermes timeout patch behavior (`0` persisted means `-1` at runtime)
- does not erase an explicit `adapterConfig.model` override

- [ ] **Step 5: Run the Hermes runtime tests to verify they fail**

Run: `pnpm test:run -- server/src/__tests__/hermes-profile-manager.test.ts server/src/__tests__/heartbeat-workspace-session.test.ts`

Expected: FAIL because there is no profile manager and no runtime injection yet.

- [ ] **Step 6: Implement the Hermes profile manager**

Add a focused service with functions equivalent to:

```ts
suggestHermesProfileBinding(...)
resolveManagedHermesHomePath(...)
scanExternalHermesProfiles(...)
materializeManagedHermesProfile(...)
resolveHermesRuntimeConfig(...)
```

Implementation rules:

- managed path root lives under the Paperclip instance root
- managed profile config is rewritten from company defaults when the run starts
- linked external profiles are never rewritten
- `adapterConfig.hermesProfile` remains the canonical saved mapping block

- [ ] **Step 7: Add path helpers**

Extend `server/src/home-paths.ts` with a helper like:

```ts
resolveManagedHermesProfileHome(companyId: string, profileName: string): string
```

Do not scatter path conventions across multiple services.

- [ ] **Step 8: Integrate Hermes runtime resolution into heartbeat execution**

In `server/src/services/heartbeat.ts`, resolve Hermes profile state after secret resolution and before adapter execution so the effective adapter config always carries `HERMES_HOME`.

- [ ] **Step 9: Re-run the targeted server tests**

Run: `pnpm test:run -- server/src/__tests__/hermes-profile-manager.test.ts server/src/__tests__/heartbeat-workspace-session.test.ts`

Expected: PASS.

- [ ] **Step 10: Commit the runtime-profile work**

```bash
git add server/src/services/hermes-profile-manager.ts server/src/home-paths.ts server/src/services/heartbeat.ts server/src/__tests__/hermes-profile-manager.test.ts server/src/__tests__/heartbeat-workspace-session.test.ts
git commit -m "feat: add Hermes staff profile runtime resolution"
```

### Task 3: Add The Company-And-Agent-Aware Hermes Suggestion API

**Files:**
- Modify: `server/src/routes/agents.ts`
- Modify: `server/src/__tests__/agent-adapter-validation-routes.test.ts`
- Reference: `server/src/services/company-adapter-settings.ts`
- Reference: `server/src/services/hermes-profile-manager.ts`

- [ ] **Step 1: Write the failing edit-mode suggestion route test**

Request:

```http
GET /api/companies/<companyId>/adapters/hermes_local/profile-suggestion?agentId=<agentId>
```

Expected response fragments:

```ts
{
  companySettings: { defaultModel: "..." },
  suggestedBinding: { mode: "managed" | "external", profileName: "..." },
  suggestedModel: "...",
  hasManagedProfileHome: boolean,
  matchingExternalProfiles: Array<{ profileName: string; path: string }>,
}
```

- [ ] **Step 2: Write the failing create-mode suggestion route test**

Request:

```http
GET /api/companies/<companyId>/adapters/hermes_local/profile-suggestion?agentName=QA%20and%20Release%20Engineer
```

Assert the route succeeds without an existing agent id and derives a stable suggested profile name from the company issue prefix plus normalized name.

- [ ] **Step 3: Run the route tests to verify they fail**

Run: `pnpm test:run -- server/src/__tests__/agent-adapter-validation-routes.test.ts`

Expected: FAIL because the route does not exist.

- [ ] **Step 4: Implement the new Hermes suggestion route**

Add a company-scoped route under `server/src/routes/agents.ts` instead of the global adapters route.

Rules:

- require company access
- allow `agentId` or `agentName`
- if `agentId` is present, prefer any saved `adapterConfig.hermesProfile`
- resolve company defaults from the company-adapter-settings service
- do not depend on the generic `detect-model` route for Hermes

- [ ] **Step 5: Apply Hermes runtime resolution to adapter environment testing**

Update the existing `POST /companies/:companyId/adapters/:type/test-environment` flow so Hermes environment tests use the same effective runtime config path as heartbeat execution.

- [ ] **Step 6: Re-run the targeted route tests**

Run: `pnpm test:run -- server/src/__tests__/agent-adapter-validation-routes.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the route work**

```bash
git add server/src/routes/agents.ts server/src/__tests__/agent-adapter-validation-routes.test.ts
git commit -m "feat: add Hermes profile suggestion APIs"
```

### Task 4: Add Hermes Defaults To Company Settings

**Files:**
- Create: `ui/src/api/companyAdapterSettings.ts`
- Modify: `ui/src/lib/queryKeys.ts`
- Modify: `ui/src/pages/CompanySettings.tsx`
- Modify: `ui/src/pages/CompanySettings.test.tsx`
- Reference: `ui/src/api/secrets.ts`

- [ ] **Step 1: Write the failing Hermes settings UI test**

Extend `ui/src/pages/CompanySettings.test.tsx` so the page:

- fetches Hermes settings for the selected company
- renders inputs for `Default Hermes model`, `Provider`, and `Base URL`
- saves through the new company-adapter-settings API

- [ ] **Step 2: Write the failing API-key secret selector test**

Assert that saving the Hermes section sends an `apiKeySecretId` instead of raw API-key text.

If the current page test harness makes the selector too awkward, keep the test at the component/event-payload level rather than trying to simulate every popover interaction.

- [ ] **Step 3: Run the company settings test to verify it fails**

Run: `pnpm test:run -- ui/src/pages/CompanySettings.test.tsx`

Expected: FAIL because the Hermes section and API client do not exist.

- [ ] **Step 4: Implement the company settings client and query keys**

Add a dedicated `companyAdapterSettingsApi` with `getHermesSettings(companyId)` and `updateHermesSettings(companyId, patch)`.

- [ ] **Step 5: Implement the Hermes section in `CompanySettings`**

Add a new settings card that:

- loads the effective Hermes company settings
- explains that Paperclip-managed staff profiles are recommended
- lets the operator set provider, base URL, default model, and API-key secret
- clearly states that staff mappings are configured per agent when Hermes is selected

- [ ] **Step 6: Re-run the targeted UI test**

Run: `pnpm test:run -- ui/src/pages/CompanySettings.test.tsx`

Expected: PASS.

- [ ] **Step 7: Run UI typecheck**

Run: `pnpm --filter @paperclipai/ui typecheck`

Expected: PASS.

- [ ] **Step 8: Commit the company settings UI**

```bash
git add ui/src/api/companyAdapterSettings.ts ui/src/lib/queryKeys.ts ui/src/pages/CompanySettings.tsx ui/src/pages/CompanySettings.test.tsx
git commit -m "feat(ui): add Hermes company settings"
```

### Task 5: Replace The Hermes Agent Form With Company-Aware Profile Suggestions

**Files:**
- Modify: `ui/src/adapters/hermes-local/index.ts`
- Modify: `ui/src/adapters/hermes-local/config-fields.tsx`
- Create: `ui/src/adapters/hermes-local/config-fields.test.tsx`
- Modify: `ui/src/adapters/hermes-local/index.test.ts`
- Modify: `ui/src/components/AgentConfigForm.tsx`
- Modify: `ui/src/components/agent-config-defaults.ts`
- Modify: `ui/src/pages/NewAgent.tsx`
- Modify: `ui/src/api/agents.ts`

- [ ] **Step 1: Write the failing Hermes config-fields suggestion test**

Render the Hermes config fields with a mocked suggestion payload and assert the UI shows:

- the effective company default model
- the suggested profile name
- whether the profile will be created or linked
- a recommended `Use managed Paperclip profile` path

- [ ] **Step 2: Write the failing adapter-switch preservation test**

Lock the behavior that switching an existing agent from `hermes_local` to another adapter and back again preserves:

```ts
adapterConfig.hermesProfile
```

instead of deleting the staff mapping block.

- [ ] **Step 3: Write the failing create-mode suggestion test**

Pass a draft agent name from `NewAgent.tsx` into the Hermes config form and assert the Hermes UI requests a create-mode suggestion without requiring the agent to be saved first.

- [ ] **Step 4: Run the targeted Hermes UI tests to verify they fail**

Run: `pnpm test:run -- ui/src/adapters/hermes-local/index.test.ts ui/src/adapters/hermes-local/config-fields.test.tsx`

Expected: FAIL because Hermes still uses the generic schema form.

- [ ] **Step 5: Switch Hermes to the custom config-fields component**

In `ui/src/adapters/hermes-local/index.ts`, replace `SchemaConfigFields` with `HermesLocalConfigFields`.

Keep Hermes' existing timeout and command-normalization behavior intact.

- [ ] **Step 6: Implement the Hermes suggestion UX**

In `ui/src/adapters/hermes-local/config-fields.tsx`, render:

- company-default summary
- suggested profile binding summary
- toggle or radio for `managed` vs `link existing`
- external-profile picker when matches exist
- small explanatory copy that Paperclip will create the managed profile if it does not exist yet

Persist the accepted mapping inside:

```ts
adapterConfig.hermesProfile = {
  mode: "managed" | "external",
  profileName: string,
  externalPath?: string | null,
}
```

- [ ] **Step 7: Preserve Hermes profile bindings across adapter changes**

Update `ui/src/components/AgentConfigForm.tsx` so adapter switches preserve `hermesProfile` in the same way it already preserves shared config keys like `env`, `promptTemplate`, and `instructionsFilePath`.

Apply the same preservation logic in create mode when changing the draft adapter type.

- [ ] **Step 8: Stop generic Hermes model detection from fighting company defaults**

When `adapterType === "hermes_local"`, prefer the company-aware Hermes suggestion response over the generic `detectModel` query for prefilled model UI.

- [ ] **Step 9: Re-run the Hermes UI tests**

Run: `pnpm test:run -- ui/src/adapters/hermes-local/index.test.ts ui/src/adapters/hermes-local/config-fields.test.tsx`

Expected: PASS.

- [ ] **Step 10: Run UI typecheck**

Run: `pnpm --filter @paperclipai/ui typecheck`

Expected: PASS.

- [ ] **Step 11: Commit the Hermes agent-form work**

```bash
git add ui/src/adapters/hermes-local/index.ts ui/src/adapters/hermes-local/config-fields.tsx ui/src/adapters/hermes-local/config-fields.test.tsx ui/src/adapters/hermes-local/index.test.ts ui/src/components/AgentConfigForm.tsx ui/src/components/agent-config-defaults.ts ui/src/pages/NewAgent.tsx ui/src/api/agents.ts
git commit -m "feat(ui): add Hermes staff profile suggestions"
```

### Task 6: Make Portability And Docs Explicit

**Files:**
- Modify: `server/src/services/company-portability.ts`
- Modify if needed: `packages/shared/src/types/company-portability.ts`
- Modify if needed: `packages/shared/src/validators/company-portability.ts`
- Modify: `server/src/__tests__/company-portability.test.ts`
- Modify: `doc/SPEC-implementation.md`

- [ ] **Step 1: Write the failing portability test**

Decide the export/import rule up front and lock it in with a failing test.

Recommended V1 rule:

- export non-secret Hermes company settings
- clear `apiKeySecretId` during export
- keep `agent.adapterConfig.hermesProfile` in the agent manifest

- [ ] **Step 2: Run the portability test to verify it fails**

Run: `pnpm test:run -- server/src/__tests__/company-portability.test.ts`

Expected: FAIL because Hermes company settings are not included or sanitized yet.

- [ ] **Step 3: Implement the chosen portability rule**

Keep the behavior explicit and documented.

If the export surface becomes too broad for this branch, document the omission clearly in `doc/SPEC-implementation.md` instead of leaving silent drift.

- [ ] **Step 4: Update the implementation spec**

Add a short section covering:

- company-scoped Hermes defaults
- staff-scoped Hermes profile bindings
- Paperclip-managed Hermes homes
- secret-backed Hermes API keys

- [ ] **Step 5: Re-run the targeted portability test**

Run: `pnpm test:run -- server/src/__tests__/company-portability.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the portability/docs work**

```bash
git add server/src/services/company-portability.ts packages/shared/src/types/company-portability.ts packages/shared/src/validators/company-portability.ts server/src/__tests__/company-portability.test.ts doc/SPEC-implementation.md
git commit -m "docs: record Hermes company settings contract"
```

Omit any untouched file from the commit.

### Task 7: Roll Out Hermes To The Two Target Companies

**Files:**
- No repo file changes required
- Runtime targets: the local Paperclip instance data for `Le bistrot` and `Snow Monster`

- [ ] **Step 1: Confirm the target companies still exist before mutating live data**

Check the local instance and confirm:

- `Le bistrot`
- `Snow Monster`

still exist on the target instance on the day of rollout.

- [ ] **Step 2: Configure Hermes company defaults for `Le bistrot`**

In `Company Settings`, set:

- Hermes provider
- Hermes base URL
- Hermes default model
- Hermes API-key secret

Verify the Hermes company-settings card saves and reloads correctly.

- [ ] **Step 3: Configure Hermes company defaults for `Snow Monster`**

Repeat the same save-and-reload verification.

- [ ] **Step 4: Update the `Le bistrot` staff to `hermes_local`**

Apply Hermes to these staff members and accept the suggested mapping for each one:

- CEO
- CMO
- CMO 2
- COO
- PricingLead

Expected result:

- each agent uses `hermes_local`
- each agent gets one saved `adapterConfig.hermesProfile`
- each managed profile is created automatically if it did not already exist

- [ ] **Step 5: Update the `Snow Monster` staff to `hermes_local`**

Apply Hermes to:

- CEO
- CMO
- COO
- CTO
- QA and Release Engineer

Use the same acceptance criteria as above.

- [ ] **Step 6: Verify every staff member resolves a unique Hermes home**

For all 10 staff members, verify:

- unique saved Hermes profile binding
- unique effective `HERMES_HOME`
- Hermes environment test passes
- company default model appears unless the agent has an explicit override

- [ ] **Step 7: Smoke-test one run per company**

Trigger one harmless run for at least one agent in each company and verify:

- the run starts with Hermes successfully
- the managed profile home exists under the Paperclip instance root
- no raw API key was persisted into the agent record

### Final Verification

- [ ] **Step 1: Run full typecheck**

Run: `pnpm -r typecheck`

Expected: PASS.

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test:run`

Expected: PASS.

- [ ] **Step 3: Run the production build**

Run: `pnpm build`

Expected: PASS.

- [ ] **Step 4: Record any verification gaps before hand-off**

If any command fails or is skipped, write down the exact command, the failure point, and whether the Hermes rollout was blocked or only the repo verification was blocked.
