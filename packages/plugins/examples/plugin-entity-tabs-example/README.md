# Entity Tabs (Example) Plugin

Reference plugin that shows how to add **detail tabs** to multiple entity types—Agent and Goal detail pages.

When enabled for a company, the plugin adds a **Plugin (Agent)** tab to the agent detail tab bar and a **Plugin (Goal)** tab to the goal detail tab bar. Each tab receives the current entity context (`entityId`, `entityType`, `companyId`) and can render custom content.

## What it demonstrates

- **detailTab** slots for multiple entity types: `entityTypes: ["agent"]` and `entityTypes: ["goal"]`
- Capability: `ui.detailTab.register`
- Multiple UI exports from one plugin: `AgentDetailTab` and `GoalDetailTab`
- Minimal worker (setup + health)

## Build and install

From repo root:

```bash
pnpm --filter @paperclipai/plugin-entity-tabs-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-entity-tabs-example
```

Enable the plugin for a company in Settings → Plugins. Then open any agent or goal; the **Plugin (Agent)** or **Plugin (Goal)** tab will appear in the detail tab bar.
