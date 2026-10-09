# Plugins and contributed product surfaces

Operators install and configure plugins, inspect their status and errors, and use their contributed pages, tools, and managed resources within the plugin’s granted capabilities.

Implementation: [plugin manager](../ui/src/pages/PluginManager.tsx), [plugin settings](../ui/src/pages/PluginSettings.tsx), [plugin page](../ui/src/pages/PluginPage.tsx).

## Sub-features

- `installation`: install a trusted test package or local development plugin through supported controls.
- `configuration`: save validated configuration and inspect activation/failure state.
- `contributions`: open plugin routes, settings, tools, and contributed resource tabs.
- `lifecycle`: disable/remove or reload a disposable plugin and observe cleanup.

## How to get to it (user POV)

### `plugin-administration`

Open Settings → Plugins where permitted, or the CLI plugin commands.

### `plugin-contribution`

Open `/plugins/:pluginId`, a registered plugin route, or its contributed company/project settings surface.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a known local fixture plugin with bounded capabilities. Record installed version and any declared external dependencies.

### `plugin-administration`

Automated: [install authorization](../server/src/__tests__/plugin-install-route-security.test.ts) and [plugin settings](../ui/src/pages/PluginSettings.test.tsx) cover route/UI contracts.

Manual: Install the fixture, supply its configuration, activate it, and inspect status. Save an invalid configuration and verify a useful error. Disable/remove the disposable plugin and check its tools and managed resources no longer behave as active.

### `plugin-contribution`

Automated: [static plugin UI](../server/src/__tests__/plugin-ui-static.test.ts) and [company settings contribution](../ui/src/pages/CompanySettingsPluginPage.test.tsx) cover serving/host behavior.

Manual: Open the contributed page by navigation and cold deep link, perform a harmless plugin action, and inspect its real outcome. Switch company and test an actor without the capability. Reload with the plugin unavailable and verify the host reports that state.

## Gotchas

- Installing a plugin does not authorize every host capability or external action.
- Plugin-provided routes are dynamic; this map covers the host lifecycle, not every third-party feature.
- Environment-driver plugins also need the [environment](./execution-environments.md) checks.
