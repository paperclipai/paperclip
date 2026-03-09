# Sidebar Modal Example Plugin

Adds a sidebar entry that opens a modal when clicked.

- **Sidebar entry**: Appears in the main app sidebar (under Company section) as "Open modal".
- **Modal**: Clicking the entry opens a host-managed modal with plugin-provided content (company context and short description).

## Build and install

```bash
pnpm --filter @paperclipai/plugin-sidebar-modal-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-sidebar-modal-example
```

Enable the plugin for a company in Company Settings → Plugins, then use the "Open modal" item in the sidebar.
