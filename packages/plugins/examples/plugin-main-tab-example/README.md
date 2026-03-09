# Main Tab (Example) Plugin

Reference plugin that shows how to add a **detail tab** to the main UI—specifically the Issue detail page.

When enabled for a company, the plugin adds a **Plugin** tab to the issue detail tab bar (alongside Comments, Subissues, Activity). The tab receives the current issue context (`entityId`, `entityType`, `companyId`) and can render custom content.

## What it demonstrates

- **detailTab** slot for `entityType: ["issue"]`
- Capability: `ui.detailTab.register`
- Minimal worker (setup + health) and a single UI export: `IssueDetailTab`

## Build and install

From repo root:

```bash
pnpm --filter @paperclipai/plugin-main-tab-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-main-tab-example
```

Enable the plugin for a company in Settings → Plugins, then open any issue; the **Plugin** tab will appear in the detail tab bar.
