# First-Party Example Plugins

These example packages are shipped in-repo as reference implementations for the plugin API in `doc/plugins/PLUGIN_SPEC.md`.

Packaging notes shared by all of them:

- They are workspace packages under `packages/plugins/examples/`.
- They publish the plugin contract via `package.json#paperclipPlugin`.
- Their compiled manifest/worker/UI outputs live under `dist/`.
- UI examples cover both `ui.slots` and declarative `ui.launchers` (see the Claude quota launcher example).

## Included Examples

1. `@paperclipai/plugin-hello-world-example`
Path: `packages/plugins/examples/plugin-hello-world-example`

- Demonstrates the smallest UI plugin: a dashboard widget that renders a "Hello world" message.
- API notes: contributes UI via existing plugin host endpoints only; no plugin-defined HTTP routes.

2. `@paperclipai/plugin-github-issues-example`
Path: `packages/plugins/examples/plugin-github-issues-example`

- Demonstrates issue lifecycle subscriptions, scheduled sync jobs, secret resolution, outbound GitHub API calls, plugin state, and agent tool registration.

3. `@paperclipai/plugin-slack-notifier-example`
Path: `packages/plugins/examples/plugin-slack-notifier-example`

- Demonstrates event-driven notifications, webhook delivery to Slack, plugin metrics, and activity log writes.

4. `@paperclipai/plugin-ntfy-notifier-example`
Path: `packages/plugins/examples/plugin-ntfy-notifier-example`

- Demonstrates event-driven notifications to ntfy.sh, custom server URLs, and secret resolution for auth tokens.

5. `@paperclipai/plugin-custom-agent-adapter-example`
Path: `packages/plugins/examples/plugin-custom-agent-adapter-example`

- Demonstrates how plugin APIs can complement a custom adapter extension by forwarding run events and exposing adapter health-check tools.
- Important: custom agent adapters are platform modules, not runtime plugins. See `docs/adapters/creating-an-adapter.md`.

6. `@paperclipai/plugin-tools-example`
Path: `packages/plugins/examples/plugin-tools-example`

- Demonstrates a focused implementation of custom agent tools, including a calculator and a mock weather lookup.
- API notes: registers tools with `ctx.tools.register`, uses `ctx.activity.log` for execution history, and shows how tools can return both content and structured data.

7. `@paperclipai/plugin-file-browser-example`
Path: `packages/plugins/examples/plugin-file-browser-example`

- Demonstrates **projectSidebarItem** (link under each project) and **detailTab** for entityType project.
- Sidebar link opens project detail with the plugin tab selected (`?tab=plugin:...`).
- Detail tab: workspace-path selector (from `ctx.projects.listWorkspaces` via getData), a desktop two-column file tree/editor view, and a mobile browser-to-editor flow with save/write support.
- Capabilities: `ui.sidebar.register`, `ui.detailTab.register`, `projects.read`, `project.workspaces.read`.

8. `@paperclipai/plugin-entity-tabs-example`
Path: `packages/plugins/examples/plugin-entity-tabs-example`

- Demonstrates **detailTab** for entityType **agent** and **goal**.
- Adds a "Plugin (Agent)" tab on Agent detail and a "Plugin (Goal)" tab on Goal detail.
- Capabilities: `ui.detailTab.register`.

9. `@paperclipai/plugin-main-tab-example`
Path: `packages/plugins/examples/plugin-main-tab-example`

- Demonstrates **detailTab** for the main UI: adds a **Plugin** tab to the **Issue** detail page.
- When enabled for a company, the tab appears in the issue detail tab bar alongside Comments, Subissues, and Activity.
- Capabilities: `ui.detailTab.register`.

10. `@paperclipai/plugin-page-example`
Path: `packages/plugins/examples/plugin-page-example`

- Demonstrates the **page** slot (company-context full page).
- When enabled for a company, the plugin page is available at `/:companyPrefix/plugins/:pluginId` (pluginId = plugin record id from the API).
- Capabilities: `ui.page.register`.

11. `@paperclipai/plugin-claude-quota-launcher-example`
Path: `packages/plugins/examples/plugin-claude-quota-launcher-example`

- Demonstrates a **declarative launcher** that opens a **modal**: toolbar button "Claude quota" opens a host-owned overlay.
- Modal shows company cost summary (spend, budget, utilization) and per-agent usage including Claude subscription token counts.
- Manifest uses `ui.launchers` with `placementZone: "toolbarButton"`, `action.type: "openModal"`, and `render: { environment: "hostOverlay", bounds: "wide" }`.
- Capabilities: `ui.action.register`.

12. `@paperclipai/plugin-sidebar-modal-example`
Path: `packages/plugins/examples/plugin-sidebar-modal-example`

- Demonstrates a **sidebar launcher** that opens a **modal**: sidebar entry "Open modal" opens a host-owned overlay.
- Modal content shows company context (company ID, prefix) and a short description.
- Manifest uses `ui.launchers` with `placementZone: "sidebar"`, `action.type: "openModal"`, and `render: { environment: "hostOverlay", bounds: "default" }`.
- Capabilities: `ui.sidebar.register`.

## Local Install (Dev)

From repo root, build the example package and install it by local path:

```bash
pnpm --filter @paperclipai/plugin-hello-world-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-hello-world-example

pnpm --filter @paperclipai/plugin-github-issues-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-github-issues-example

pnpm --filter @paperclipai/plugin-entity-tabs-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-entity-tabs-example

pnpm --filter @paperclipai/plugin-main-tab-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-main-tab-example

pnpm --filter @paperclipai/plugin-page-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-page-example

pnpm --filter @paperclipai/plugin-claude-quota-launcher-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-claude-quota-launcher-example

pnpm --filter @paperclipai/plugin-sidebar-modal-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-sidebar-modal-example
```

Repeat for the GitHub, Slack, and custom-adapter examples by changing the package name/path.

**Local development notes:**

- **Build first.** The host discovers the compiled manifest and worker through `package.json#paperclipPlugin` (for example `./dist/manifest.js` and `./dist/worker.js`). Run `pnpm build` (or `pnpm --filter <package> build`) in the plugin directory before installing so those files exist. The worker file must call `runWorker(plugin, import.meta.url)` so the process stays alive when run as the entrypoint (see PLUGIN_AUTHORING_GUIDE.md).
- **Reinstall after pulling.** If you installed a plugin by local path before the server stored `package_path`, the plugin may show status **error** (worker not found). Uninstall and install again so the server persists the path and can activate the plugin:  
  `pnpm paperclipai plugin uninstall <pluginKey> --force` then  
  `pnpm paperclipai plugin install ./packages/plugins/examples/<plugin-dir>`.

---

## Developer Tools & Skills

### `paperclip-create-plugin` (Agent Skill)
Path: `skills/paperclip-create-plugin/`

This is an agent skill designed for AI agents (Claude, Gemini, etc.) to help them autonomously build Paperclip plugins.

- **Workflow:** Guides agents from requirement analysis and scaffolding to implementation and testing.
- **Reference Docs:** Includes local copies of the Plugin SDK API, Manifest schema, and UI component reference.
- **Usage:** Agents can activate this skill using their respective `activate_skill` tool:
  ```
  activate_skill(name: "paperclip-create-plugin")
  ```
- **Integrity Tests:** Automated tests in `cli/src/__tests__/paperclip-create-plugin-skill.test.ts` ensure the skill's documentation remains valid and complete.
