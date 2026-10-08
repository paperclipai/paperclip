# Companies and portability

An operator can switch between companies, change their identity and settings, archive them, and preview an import or export. Each company remains a separate scope for work and agents.

Implementation: [companies](../ui/src/pages/Companies.tsx), [settings](../ui/src/pages/CompanySettings.tsx), [import](../ui/src/pages/CompanyImport.tsx), [export](../ui/src/pages/CompanyExport.tsx).

## Sub-features

- `selection`: create/select a company and keep navigation in its scope.
- `identity`: update company identity and configured settings.
- `archive`: archive and restore through the available controls without confusing archival with deletion.
- `portability`: preview a company package and inspect imported agents, projects, skills, and conflicts.

## How to get to it (user POV)

### `company-switcher`

Use the company switcher or `/companies`, then enter company Settings.

### `package-transfer`

Use `/company/export` and `/company/import` where enabled, or the corresponding CLI company commands.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use two disposable companies and a small package fixture. Record cloud-managed restrictions and visible settings gates.

### `company-switcher`

Automated: [company list](../ui/src/pages/Companies.test.tsx) and [archive UI](../ui/src/pages/CompanySettingsArchive.test.tsx) cover UI behavior with mocks.

Manual: Create or select a company, rename it, and reload. Switch to the second company and back; verify tasks, agents, and settings follow the selection. Archive the disposable company and verify its visibility and offered restoration path.

### `package-transfer`

Automated: [portability routes](../server/src/__tests__/company-portability-routes.test.ts) and [CLI import/export](../cli/src/__tests__/company-import-export-e2e.test.ts) cover package and command behavior, not every external Git host.

Manual: Export a small company, inspect the package preview, and import into a disposable target. Verify counts, references, conflict choices, and agent configuration. Run one imported task after supplying its required local credentials. Confirm source company data is unchanged.

## Gotchas

- Package presence does not prove a runnable imported company; credentials and environment bindings need separate verification.
- Company deletion is a distinct gated operation; do not use it as the archive test.
- Settings hidden in a managed deployment should be recorded as unavailable, not bypassed.
