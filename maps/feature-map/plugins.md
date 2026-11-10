---
navigation: {"section":"Apps, channels, and extensions","sectionOrder":50,"order":60}
---

# Plugins

Operators install and configure plugins, inspect their status and errors, and use their contributed pages, tools, and managed resources within the plugin’s granted capabilities.

Feature ID: `plugins`.

Implementation: [plugin manager](../../ui/src/pages/PluginManager.tsx), [plugin settings](../../ui/src/pages/PluginSettings.tsx), [plugin page](../../ui/src/pages/PluginPage.tsx).

Agent access: [companion](../agent-access-map/plugins.md).

## Sub-features

- `installation`: `plugins/installation` — install a trusted test package or local development plugin through supported controls.
- `configuration`: `plugins/configuration` — save validated configuration and inspect activation/failure state.
- `contributions`: `plugins/contributions` — open plugin routes, settings, tools, and contributed resource tabs.
- `lifecycle`: `plugins/lifecycle` — disable/remove or reload a disposable plugin and observe cleanup.

## How to get to it (user POV)

### `plugin-administration`

Open Settings → Plugins where permitted, or the CLI plugin commands.

### `plugin-contribution`

Open `/plugins/:pluginId`, a registered plugin route, or its contributed company/project settings surface.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a known local fixture plugin with bounded capabilities. Record installed version and any declared external dependencies.

### `plugin-administration`

Automated: [install authorization](../../server/src/__tests__/plugin-install-route-security.test.ts) and [plugin settings](../../ui/src/pages/PluginSettings.test.tsx) cover route/UI contracts.

Manual: Install the fixture, supply its configuration, activate it, and inspect status. Save an invalid configuration and verify a useful error. Disable/remove the disposable plugin and check its tools and managed resources no longer behave as active.

### `plugin-contribution`

Automated: [static plugin UI](../../server/src/__tests__/plugin-ui-static.test.ts) and [company settings contribution](../../ui/src/pages/CompanySettingsPluginPage.test.tsx) cover serving/host behavior.

Manual: Open the contributed page by navigation and cold deep link, perform a harmless plugin action, and inspect its real outcome. Switch company and test an actor without the capability. Reload with the plugin unavailable and verify the host reports that state.

## Gotchas

- Installation/lifecycle is instance-level; configuration can be company-scoped.
  Settings lives at `/company/settings/instance/plugins`. npm installation and
  bundled-local installation are different controls. Developer file-watcher
  reload is not a lifecycle action in the plugin manager.

- Installing a plugin does not authorize every host capability or external action.
- Runtime synchronization is opt-in and uses durable resource delivery. See
  [the contract](../../doc/plugins/AGENT_RUNTIME_SYNC.md) and
  [database regressions](../../server/src/__tests__/agent-runtime-hooks.test.ts).
- Plugin-provided routes are dynamic; this map covers the host lifecycle, not every third-party feature.
- Environment-driver plugins also need the [environment](./execution-environments.md) checks.

### Storybook verification

#### `installation`

Capability ID: `plugins/installation`.

Scope: ui
Storybook: Mount PluginManager trusted package and bundled-local choices, pending install, validation/recoverable error and installed status.
Production: POST /plugins/install on a disposable package; enforce instance install authority, trusted path/package validation and correct version. Package and local install are distinct.
Sources: Source: [PluginManager.tsx](../../ui/src/pages/PluginManager.tsx), [plugins.ts](../../server/src/routes/plugins.ts), [plugin-install-guard.ts](../../server/src/services/plugin-install-guard.ts). Tests: [plugin-install-route-security.test.ts](../../server/src/__tests__/plugin-install-route-security.test.ts), [plugin-install-autobuild.test.ts](../../server/src/__tests__/plugin-install-autobuild.test.ts), [plugin-routes-authz.test.ts](../../server/src/__tests__/plugin-routes-authz.test.ts)

#### `configuration`

Capability ID: `plugins/configuration`.

Scope: ui
Storybook: Mount PluginSettings valid/invalid schema inputs, saved configuration, pending/failure and unavailable plugin.
Production: GET/POST /plugins/{id}/config and POST config/test must preserve validation/company scope and deliver saved config to real plugin worker/startup.
Sources: Source: [PluginSettings.tsx](../../ui/src/pages/PluginSettings.tsx), [plugins.ts](../../server/src/routes/plugins.ts), [plugin-config-validator.ts](../../server/src/services/plugin-config-validator.ts). Tests: [PluginSettings.test.tsx](../../ui/src/pages/PluginSettings.test.tsx), [plugin-config-startup-delivery.test.ts](../../server/src/__tests__/plugin-config-startup-delivery.test.ts), [plugin-routes-authz.test.ts](../../server/src/__tests__/plugin-routes-authz.test.ts)

#### `contributions`

Capability ID: `plugins/contributions`.

Scope: ui
Storybook: Mount PluginPage and CompanySettingsPluginPage contributed routes/tabs, loading, missing/unavailable plugin and action failures with a known fixture plugin.
Production: Serve real static plugin UI; enforce bridge data/action host capabilities and company boundaries; exercise a harmless action and cold deep link.
Sources: Source: [PluginPage.tsx](../../ui/src/pages/PluginPage.tsx), [CompanySettingsPluginPage.tsx](../../ui/src/pages/CompanySettingsPluginPage.tsx), [plugins.ts](../../server/src/routes/plugins.ts), [plugin-ui-static.ts](../../server/src/routes/plugin-ui-static.ts). Tests: [PluginPage.test.tsx](../../ui/src/pages/PluginPage.test.tsx), [CompanySettingsPluginPage.test.tsx](../../ui/src/pages/CompanySettingsPluginPage.test.tsx), [plugin-ui-static.test.ts](../../server/src/__tests__/plugin-ui-static.test.ts), [plugin-tenant-isolation.test.ts](../../server/src/__tests__/plugin-tenant-isolation.test.ts)

#### `lifecycle`

Capability ID: `plugins/lifecycle`.

Scope: ui
Storybook: Mount PluginManager active/disabled/uninstall/upgrade pending and failures; distinguish operator controls from developer watcher reload.
Production: POST enable/disable and DELETE /plugins/{id} must stop worker/tool/managed-resource activity and clean owned resources; verify disposable restart/uninstall and developer watcher separately.
Sources: Source: [PluginManager.tsx](../../ui/src/pages/PluginManager.tsx), [plugins.ts](../../server/src/routes/plugins.ts), [plugin-lifecycle.ts](../../server/src/services/plugin-lifecycle.ts), [plugin-dev-watcher.ts](../../server/src/services/plugin-dev-watcher.ts). Tests: [plugin-lifecycle-restart.test.ts](../../server/src/__tests__/plugin-lifecycle-restart.test.ts), [plugin-routes-authz.test.ts](../../server/src/__tests__/plugin-routes-authz.test.ts), [plugin-dev-watcher.test.ts](../../server/src/__tests__/plugin-dev-watcher.test.ts)

### Documentation scope: Plugins, gateways, and tool profiles

Host plugin/gateway/profile lifecycles are mapped. Third-party plugin behaviors and every client transport/provider combination are outside host-wide coverage.
