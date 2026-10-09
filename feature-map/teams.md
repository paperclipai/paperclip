# Team packages and catalog installation

Operators can preview and install a team package with its agents and related resources. Catalog/package installation is available through the CLI/API; the repository also contains catalog UI components that are not a current top-level route.

Implementation: [CLI teams](../cli/src/commands/client/teams.ts), [catalog components](../ui/src/pages/TeamCatalog.tsx).

## Sub-features

- `discovery`: list available team catalog entries and inspect package contents.
- `preview`: inspect proposed resources and installation options before mutation.
- `install`: install into the intended company and inspect resulting agents and resources.
- `configuration`: supply required adapters/accounts and verify installed agents can work.

## How to get to it (user POV)

### `catalog-cli`

Use the CLI teams catalog/preview/install operations in the selected context.

### `catalog-components`

The catalog components and install wizard are available in developer tests/design surfaces. No top-level `/teams` route is registered; use the CLI/API for the current installation workflow.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a disposable company, a small catalog entry, and explicit company context. Check `paperclipai teams --help` for current subcommands.

### `catalog-cli`

Automated: [team commands](../cli/src/__tests__/teams.test.ts) and [catalog service](../server/src/__tests__/teams-catalog-service.test.ts) cover command and service contracts.

Manual: List an entry, preview its proposed agents and resources, install it into the disposable company, and inspect each created resource. Run a small task after configuring accounts. Retry preview/install as supported and inspect duplicate/conflict behavior.

### `catalog-components`

Automated: [catalog component](../ui/src/pages/TeamCatalog.test.tsx) and [install hook](../ui/src/pages/useInstallTeamCatalogEntry.test.tsx) cover preview and install UI logic with mocks.

Manual: When changing or mounting these components, exercise preview, manager/source options, cancellation, failed install, and success. Follow created agents in the actual company. Record whether this was a component harness or a real product entry point.

## Gotchas

- Source files do not prove that a screen is reachable in the current app.
- Installed team configuration may still need credentials or environment setup.
- Company package import is a separate [portability](./companies.md) workflow.
