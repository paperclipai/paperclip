---
"@paperclipai/server": patch
"@paperclipai/plugin-sdk": patch
---

Fix critical issues in the plugin system initialization and host communication:
- Implement production `HostServices` to bridge the plugin SDK with core domain services (companies, projects, issues, etc.).
- Ensure all plugins in 'ready' status are automatically started when the server boots.
- Parallelize plugin loading at startup using `Promise.allSettled` for faster boot times.
- Ensure `lifecycle.load()` correctly triggers worker startup, matching the behavior of `enable()`.
- Added required `companyId` to `PluginActivityLogEntry` and updated the RPC protocol for better auditing.
- Fixed a bug in worker-side event filtering to maintain consistency with the server.
