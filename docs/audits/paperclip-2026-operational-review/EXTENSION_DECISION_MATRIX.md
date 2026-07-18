# Paperclip Operational Audit 2026 — Sprint 4
## EXTENSION_DECISION_MATRIX

**Evidence date:** 2026-07-15  
**Scope:** Comparison of all extension mechanisms available in Paperclip for adding new capabilities without core modification.

---

## Extension Mechanisms Compared

| Dimension | Core Modification | Native Plugin | External Service + API | External Adapter Plugin | Routine | HTTP/Webhook Agent | MCP Client | Ordinary Paperclip Agent |
|-----------|------------------|---------------|------------------------|------------------------|---------|-------------------|------------|-------------------------|
| **Intended purpose** | Change fundamental platform behavior | Extend platform with new capabilities | Integrate external systems | Add new agent backends | Recurring scheduled/agent work | Agent that executes via HTTP | Agent that uses MCP tools | General autonomous work |
| **Data ownership** | Paperclip owns all state | Plugin owns `plugin_*` tables; Paperclip owns core | External system owns external data; Paperclip owns issues/activity | Paperclip owns runs; adapter owns external session | Paperclip owns routine + issue + run | Paperclip owns runs; external system owns execution | Paperclip owns runs; MCP server owns tool state | Paperclip owns runs + issues |
| **UI capability** | Full control over UI | Slots, launchers, pages, widgets, streams | None (unless external service has its own UI) | Config schema + UI parser only | None (routines create issues, which have core UI) | None (agent config only) | None (agent config only) | None (agent config only) |
| **Background execution** | Server process | Out-of-process worker | External process | Agent runs via heartbeat | Cron/webhook/API triggered | Agent runs via heartbeat | Agent runs via heartbeat | Agent runs via heartbeat |
| **Secrets** | Full access to all secrets | Scoped to plugin config refs (config-referenced secrets only) | External system manages its own secrets | Agent config secrets | Routine webhook secrets | Agent config secrets | Agent config secrets | Agent config secrets |
| **Governance compatibility** | N/A (core has no governance) | Capabilities enforce least-privilege; no approval gates in plugin SDK | Governed by API auth (board/agent keys) | Governed by agent config + approval gates | Full routine governance (concurrency, catch-up, agent assignment) | Governed by agent execution policy | Governed by agent execution policy | Governed by agent execution policy + approvals |
| **Auditability** | Code review + git history | Plugin actions logged as `actorType: "plugin"`; job runs in `plugin_job_runs`; webhook deliveries in `plugin_webhook_deliveries` | API mutations logged in `activity_log` with actor info | Runs in `heartbeat_runs` with context snapshot | Runs in `routine_runs` + linked issues + activity log | Runs in `heartbeat_runs` | Runs in `heartbeat_runs` | Runs in `heartbeat_runs` + issue history |
| **Deployment coupling** | Server deployment required | Independent package (npm or local path); host reloads at runtime | Completely decoupled; runs anywhere | Independent package; host reloads at runtime | No deployment; configured via UI/API | No deployment; configured as agent | No deployment; configured as agent | No deployment; configured as agent |
| **Company isolation** | All companies | Instance-wide plugin; no per-company worker isolation (but data is company-scoped) | Per-company via API key scoping | Per-company via agent config | Per-company by schema design | Per-company via agent config | Per-company via agent config | Per-company by schema design |
| **Current maturity** | N/A | High — full lifecycle, SDK, manifest validation, capability enforcement, bridge, streams | High — REST API is mature and typed | High — external adapter system is production-ready | High — full cron, webhook, API triggers; concurrency policies | High — `http` and `process` adapters are built-in | Medium — MCP spec exists but implementation not verified | High — core agent system is mature |
| **Evidence** | Source code | `plugin-loader.ts`, `plugin-worker-manager.ts`, `plugin-host-services.ts`, `define-plugin.ts`, `PLUGIN_SPEC.md` references | `routes/issues.ts`, `routes/approvals.ts`, `routes/routines.ts`, `authz.ts` | `adapter-plugin-store.ts`, `plugin-loader.ts`, `routes/adapters.ts`, `builtin-adapter-types.ts` | `routines.ts` (schema + service + routes), `cron.ts` | `builtin-adapter-types.ts` (includes `http`), adapter types | `doc/TASKS-mcp.md` specification | `heartbeat_runs.ts`, `agents.ts`, `issues.ts`, `routes/issues.ts` |
| **Known limitations** | Requires PR, review, deploy | No formal sandbox (full Node.js process trust model); no per-company worker isolation; no inline approval UI | No inbound events without polling or webhooks | Cannot hot-install builtin overrides; UI parser has no graceful fallback for malformed JS | Catch-up burst runs synchronously in tick; no persistent catch-up queue | HTTP adapter timeout/retry not configurable in adapter interface | MCP server implementation not found in codebase | Requires agent creation, config, and assignment |

---

## Recommended Extension Mechanism by Use Case

| Use Case | Recommended Mechanism | Rationale |
|----------|----------------------|-----------|
| Email intake → issue creation | **Routine + webhook trigger** | Webhook receives events; routine creates issue and wakes agent; fully auditable |
| Email intake → complex parsing/classification | **Native Plugin** | Plugin receives webhook, parses email, uses `issues.create` + custom logic; can store state |
| External system sync (e.g., Linear, GitHub) | **Native Plugin** | Scheduled jobs + webhooks + entity mappings + tools; full SDK support |
| New AI agent backend (e.g., new LLM provider) | **External Adapter Plugin** | Clean separation; config schema + UI parser; no core UI changes |
| Recurring report generation | **Routine + schedule trigger** | Cron scheduling; variable interpolation; automatic issue creation |
| One-off external integration | **External Service + API** | No Paperclip deployment needed; just API calls |
| Agent needs external tool access | **HTTP/Webhook Agent** or **MCP Client** | HTTP adapter for generic APIs; MCP for structured tools |
| Custom dashboard for operators | **Native Plugin (dashboardWidget + page)** | Full UI extension with bridge to worker backend |
| Approval workflow customization | **Core Modification** (currently) | No plugin slot for approval UI; no plugin capability for creating approvals |
| Custom issue list columns/board view | **Core Modification** (currently) | No plugin slot for list/board customization |

---

*Evidence-backed. No recommendations for email implementation design.*
