---
navigation: {"section":"Getting started and access","sectionOrder":10,"order":30}
---

# Companies and portability

An operator can switch between companies, change their identity and settings, archive them, and preview an import or export. Each company remains a separate scope for work and agents.

Feature ID: `companies`.

Implementation: [companies](../../ui/src/pages/Companies.tsx), [settings](../../ui/src/pages/CompanySettings.tsx), [import](../../ui/src/pages/CompanyImport.tsx), [export](../../ui/src/pages/CompanyExport.tsx).

Agent access: [companion](../agent-access-map/companies.md).

## Sub-features

- `selection`: `companies/selection` — create/select a company and keep navigation in its scope.
- `identity`: `companies/identity` — update company identity and configured settings.
- `decision-models`: `companies/decision-models` — configure and test the company's decision model, then inspect invocation history and recorded usage.
- `prompt-injection-prevention`: `companies/prompt-injection-prevention` — opt into a shared OpenRouter classifier for existing tool-result guards, test fixed samples, and recover unavailable selections.
- `fast-responses`: `companies/fast-responses` — configure and test the experimental fast-response service, then inspect acknowledgement history, failures, and recorded usage.
- `agent-observability`: `companies/agent-observability` — configure one company OTLP destination for Codex, Claude Code and native OpenCode, test synthetic delivery, and disable export.
- `archive`: `companies/archive` — archive and restore through the available controls without confusing archival with deletion.
- `portability`: `companies/portability` — preview a company package and inspect imported agents, projects, skills, and conflicts.

## How to get to it (user POV)

### `company-switcher`

Use the company switcher or `/companies`, then enter company Settings.

### `package-transfer`

Use `/company/export` and `/company/import` where enabled, or the corresponding CLI company commands.

### `company-ai-services`

Use Settings → Connections (`/company/settings/connections`) for Decision model
and Prompt Injection Prevention, independent of experimental flags. Fast response
appears there only when its experiment is enabled.
Open the Decisions and Fast responses tabs in Costs to inspect invocation history.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use two disposable companies and a small package fixture. Record cloud-managed restrictions and visible settings gates.

### `company-switcher`

Automated: [company list](../../ui/src/pages/Companies.test.tsx) and [archive UI](../../ui/src/pages/CompanySettingsArchive.test.tsx) cover UI behavior with mocks.

Manual: Create or select a company, rename it, and reload. Switch to the second company and back; verify tasks, agents, and settings follow the selection. Archive the disposable company and verify its visibility and offered restoration path.

### `package-transfer`

Automated: [portability routes](../../server/src/__tests__/company-portability-routes.test.ts) and [CLI import/export](../../cli/src/__tests__/company-import-export-e2e.test.ts) cover package and command behavior, not every external Git host.

Manual: Export a small company, inspect the package preview, and import into a disposable target. Verify counts, references, conflict choices, and agent configuration. Run one imported task after supplying its required local credentials. Confirm source company data is unchanged.

### `company-ai-services`

Automated: [decision settings](../../ui/src/components/decision-models/DecisionModelSettings.test.tsx),
[decision history](../../ui/src/components/decision-models/DecisionHistory.test.tsx),
[fast-response settings](../../ui/src/components/fast-responses/FastResponseSettings.test.tsx),
[decision service](../../server/src/__tests__/decision-models.test.ts), and
[fast-response service](../../server/src/__tests__/fast-responses.test.ts) cover
component and service contracts with simulated providers.

Manual: As an authorized connection manager, select a disposable shared AI
connection, save the provider/model and sponsorship options, reload, and run the
bounded Test action. Inspect success and failure receipts and their history in
Costs. Verify disabled or revoked connections remain clear and that a user
without connection-management permission cannot configure or test the service.
Use an owned provider fixture for failure states; record any actual provider usage.

## Gotchas

- Restore an archived company through `/companies` → its menu → **Unarchive**.
  Archiving pauses eligible agents and cancels active runs; restoration handles
  agents paused specifically for company archival.

- Package presence does not prove a runnable imported company; credentials and environment bindings need separate verification.
- Company deletion is a distinct gated operation; do not use it as the archive test.
- Settings hidden in a managed deployment should be recorded as unavailable, not bypassed.
- Decision tests and fast responses have different request and execution contracts.
  A fast-response receipt is an acknowledgement, not completed agent work.
  History visibility and connection-management authority are separate; task links
  in history also require access to the underlying task.

### Storybook verification

#### `selection`

Capability ID: `companies/selection`.

Scope: ui
Storybook: Company list/create/switcher; empty, loading, error, unavailable company and switched navigation.
Production: Switch and reload between companies; verify tasks/agents/cache/routes remain scoped and unauthorized company requests fail.
Sources: Source: [Companies.tsx](../../ui/src/pages/Companies.tsx), [CompanySwitcher.tsx](../../ui/src/components/CompanySwitcher.tsx), [CompanyContext.tsx](../../ui/src/context/CompanyContext.tsx). Tests: [Companies.test.tsx](../../ui/src/pages/Companies.test.tsx), [CompanyContext.test.tsx](../../ui/src/context/CompanyContext.test.tsx), [companies-route-cross-company-authz.test.ts](../../server/src/__tests__/companies-route-cross-company-authz.test.ts)

#### `archive`

Capability ID: `companies/archive`.

Scope: ui
Storybook: Archive confirmation, pending/error and departure navigation; archived list entry and Unarchive action.
Production: Archive eligible agents/runs without deleting history; restoration handles archival-specific pause and navigates to correct company.
Sources: Source: [CompanySettings.tsx](../../ui/src/pages/CompanySettings.tsx), [Companies.tsx](../../ui/src/pages/Companies.tsx), [companies.ts](../../ui/src/api/companies.ts). Tests: [CompanySettingsArchive.test.tsx](../../ui/src/pages/CompanySettingsArchive.test.tsx), [Companies.test.tsx](../../ui/src/pages/Companies.test.tsx), [companies-service.test.ts](../../server/src/__tests__/companies-service.test.ts)

#### `portability`

Capability ID: `companies/portability`.

Scope: ui
Storybook: Import/export preview, conflict choice, warnings, async progress/failure/success and restricted managed deployment.
Production: Apply real small package to disposable target; inspect counts/references/conflicts, source immutability and credential exclusions; imported task requires separate runnable-account proof.
Sources: Source: [CompanyImport.tsx](../../ui/src/pages/CompanyImport.tsx), [CompanyExport.tsx](../../ui/src/pages/CompanyExport.tsx), [companies.ts](../../ui/src/api/companies.ts). Tests: [CompanyImport.test.tsx](../../ui/src/pages/CompanyImport.test.tsx), [CompanyExport.test.tsx](../../ui/src/pages/CompanyExport.test.tsx), [company-portability-routes.test.ts](../../server/src/__tests__/company-portability-routes.test.ts), [company-import-export-e2e.test.ts](../../cli/src/__tests__/company-import-export-e2e.test.ts)

### Documentation scope: Company and instance administration

Core administration/import/export/operator workflows are mapped; cloud/self-hosted differences, migration/restore compatibility, and platform-specific service variants need deeper recipes.

### `agent-observability`

Use Company Settings → General → Agent observability. Select Braintrust or Custom OTLP,
save credentials and capture settings, then test the saved destination. Saving is offline;
the test originates at the control plane and does not prove remote runner reachability.

Automated: shared validation, encrypted configuration service, receiver tests, runtime projection,
and production settings stories cover their respective boundaries. Provider delivery requires a real run.

Manual: configure a disposable company, reload, test, run Codex, Claude Code and native OpenCode locally and remotely,
inspect their unique markers at the destination, then disable and verify a new marker is absent.

Storybook verification: `agent-observability-01-settings`, `agent-observability-02-states`,
and `agent-observability-03-journey` mount production subjects with simulated APIs/providers.

### `prompt-injection-prevention`

Capability ID: `companies/prompt-injection-prevention`.

Scope: ui, api, runtime
Storybook: Production PromptInjectionPreventionSettingsView states under Companies
and portability → Prompt Injection Prevention. Provider data is simulated.
Automated: [settings](../../ui/src/components/prompt-injection-prevention/PromptInjectionPreventionSettings.test.tsx),
[service](../../server/src/__tests__/prompt-injection-prevention.test.ts),
[gateway](../../server/src/__tests__/prompt-injection-gateway.test.ts),
[guards](../../server/src/__tests__/tool-content-guards.test.ts) including redaction
that hides content still delivered under the existing return contract.
Manual: Open Connections with Fast Responses off, save a shared OpenRouter
connection/default model, reload, run both fixed samples, and inspect charges.
Verify benign code reaches a gateway caller, malicious instructions are blocked,
provider failure records regex fallback, and disabling makes no model call.
Root results with concealed instruction text use `input_redaction_mismatch`
fallback without model dispatch.
