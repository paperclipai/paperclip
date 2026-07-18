# Paperclip Operational Audit 2026 — Sprint 4
## 09B UI EXTENSION POINTS

**Evidence date:** 2026-07-15  
**Scope:** Plugin UI contribution registration, supported slot types, rendering locations, navigation integration, data fetching, authentication, company scoping, governance initiation, and core UI modification requirements.

---

## 1. How Plugin UI Contributions Are Registered

Plugins declare UI contributions in their manifest under `ui.slots` and `ui.launchers` (or legacy top-level `launchers`). The host does not load or evaluate UI code at install time. Instead:

1. The manifest JSON is persisted in `plugins.manifest_json`.
2. At server startup (and on plugin enable), the host extracts UI metadata via `getPluginUiContributionMetadata()`.
3. The frontend queries `GET /api/plugins/ui-contributions` to receive all ready plugins' slot and launcher declarations.
4. The frontend dynamically imports the plugin UI bundle from `/_plugins/{pluginId}/ui/{uiEntryFile}` (served by `plugin-ui-static.ts`).

**Key symbols:**
- `server/src/services/plugin-loader.ts::getPluginUiContributionMetadata()`
- `server/src/routes/plugins.ts::GET /api/plugins/ui-contributions`
- `server/src/routes/plugin-ui-static.ts`

**Confidence: HIGH**

---

## 2. Supported Contribution Types

### 2.1 UI Slots (`manifest.ui.slots`)
Each slot has: `type`, `id`, `displayName`, `exportName`, `entityTypes?`, `routePath?`, `order?`.

| Type | Render Location | Context |
|------|-----------------|---------|
| `sidebar` | Left sidebar | Global |
| `sidebarPanel` | Sidebar panel area | Global |
| `projectSidebarItem` | Project-level sidebar | Project scoped |
| `page` | Full page route | `/:companyPrefix/{routePath}` |
| `detailTab` | Entity detail tab bar | Requires `entityTypes` |
| `taskDetailView` | Task detail view | Requires `entityTypes` |
| `dashboardWidget` | Dashboard widget grid | Global / company scoped |
| `globalToolbarButton` | Global toolbar | Global |
| `toolbarButton` | Context toolbar | Entity scoped |
| `contextMenuItem` | Context menu | Entity scoped |
| `commentAnnotation` | Comment annotation | Entity scoped |
| `commentContextMenuItem` | Comment context menu | Entity scoped |
| `settingsPage` | Instance settings | Global |

### 2.2 Launchers (`manifest.ui.launchers`)
Declarative entry points independent of slot implementation:
- `placementZone` — where the launcher appears (mirrors slot types)
- `action` — what happens when activated (`type`: `openModal` | `openDrawer` | `navigate` | `openUrl`)
- `render` — optional container hints (`environment`, `bounds`)

**Confidence: HIGH**

---

## 3. Rendering Location and Bundle Serving

- UI bundles are served from the plugin package's `entrypoints.ui` directory.
- The host expects the entry module to be `index.js`.
- Static route: `GET /_plugins/{pluginId}/ui/*` → serves files from the plugin's UI directory.
- The frontend constructs import URLs dynamically.

**Key symbols:**
- `server/src/routes/plugin-ui-static.ts`
- `packages/shared/src/types/plugin.ts::PluginUiContributionMetadata.uiEntryFile` (hardcoded `"index.js"`)

**Confidence: HIGH**

---

## 4. Navigation Integration

### 4.1 Page slots
- Plugins can declare `page` slots with `routePath`.
- The route becomes `/:companyPrefix/{routePath}`.
- The host checks for route path collisions at install time (`assertPageRoutePathsAvailable()`).

### 4.2 Launcher navigation
- `action.type = "navigate"` → navigates to a host route or plugin page route.
- `action.type = "openUrl"` → opens external URL.

### 4.3 No deep-linking API for plugin pages
There is no documented API for plugins to programmatically navigate the host router from the worker. Navigation is UI-side only.

**Confidence: HIGH** — for implemented features; partial for programmatic navigation.

---

## 5. Data-Fetching Boundaries

### 5.1 Bridge: `getData`
- Frontend calls `POST /api/plugins/{pluginId}/bridge/data` (or `.../data/{key}`) with `{ key, params?, companyId?, renderEnvironment? }`.
- Host forwards to worker via `getData` RPC.
- Worker handler returns arbitrary JSON.
- Response wrapped as `{ data: result }`.

### 5.2 Bridge: `performAction`
- Frontend calls `POST /api/plugins/{pluginId}/bridge/action` (or `.../actions/{key}`) with `{ key, params?, companyId?, renderEnvironment? }`.
- Host forwards to worker via `performAction` RPC.
- Worker handler returns arbitrary JSON.

### 5.3 SSE Streams
- `GET /api/plugins/{pluginId}/bridge/stream/{channel}?companyId=...`
- Server-Sent Events for real-time push from worker to UI.
- Worker emits via `ctx.streams.emit(channel, event)`.
- Fan-out via `PluginStreamBus` (in-memory pub/sub).

### 5.4 Scoped API routes
- Plugins can declare `apiRoutes` in manifest.
- Mounted at `/api/plugins/{pluginId}/api/*`.
- Host enforces auth, company resolution, and checkout policy before dispatching to worker `onApiRequest`.

**Confidence: HIGH**

---

## 6. Authentication and Company Scoping

### 6.1 Board access
- All UI contribution routes require `assertBoardOrgAccess()`.
- The frontend runs in board context (full-control operator).

### 6.2 Company scoping
- Bridge calls accept optional `companyId` in body.
- If `companyId` is provided, `assertCompanyAccess(req, companyId)` is enforced.
- If omitted, `assertInstanceAdmin(req)` is required.
- SSE streams require `companyId` query parameter.

### 6.3 Scoped API routes
- `auth` mode per route: `board`, `agent`, or `webhook`.
- `companyResolution` determines how the company is resolved: `from: "body"`, `from: "query"`, or `from: "issue"`.
- `checkoutPolicy` can require agent run ownership for in-progress issues.

**Confidence: HIGH**

---

## 7. Can a Plugin Provide a Full Operational View?

**Yes, partially.** A plugin can provide:
- Full pages (`page` slot) at company-scoped routes.
- Dashboard widgets (`dashboardWidget`).
- Detail tabs and task detail views for any entity type.
- Real-time streams.
- Scoped API routes for backend integration.

**Limitations:**
- The plugin cannot replace core navigation or the main layout shell.
- The plugin cannot intercept core route transitions.
- The plugin's operational view is constrained to its declared slots and routes.

**Confidence: HIGH**

---

## 8. Can UI Contributions Initiate Governed Actions?

**Indirectly yes.** A plugin UI component can call `performAction` on its worker, and the worker can:
- Create issues (`issues.create` capability)
- Add comments (`issue.comments.create` capability)
- Request wakeups (`issues.requestWakeup` capability)
- Log activity (`activity.log` capability)
- Emit events (`events.emit` capability)

**However:**
- There is **no direct UI-to-approval flow**. A plugin cannot display an approval gate inline with core approval UI without core UI modifications.
- A plugin cannot create `approvals` or `issue_approvals` directly through the plugin host services — those operations are not exposed in `OPERATION_CAPABILITIES`.

**Evidence:**
- `plugin-host-services.ts` — `issues.create`, `issues.update`, `issue.comments.create`, `activity.log`, `events.emit` are all present.
- No `approvals.create`, `issue_approvals.link`, or similar operations in `OPERATION_CAPABILITIES`.

**Confidence: HIGH** — for what is exposed; gap identified for approvals.

---

## 9. What Requires Core UI Modification

| Capability | Requires Core UI Edit? |
|-----------|----------------------|
| Add a new sidebar item | No — `sidebar` / `projectSidebarItem` slot |
| Add a dashboard widget | No — `dashboardWidget` slot |
| Add a detail tab | No — `detailTab` slot |
| Add a full page | No — `page` slot |
| Add toolbar buttons | No — `toolbarButton` / `globalToolbarButton` slot |
| Add comment annotations | No — `commentAnnotation` slot |
| Add a settings page | No — `settingsPage` slot |
| Real-time streaming | No — SSE bridge |
| Scoped backend API | No — `apiRoutes` manifest declaration |
| Custom agent tools | No — `tools` manifest declaration |
| **Inline approval UI** | **Yes** — no plugin slot for approval workflow |
| **Custom issue list columns** | **Yes** — no slot for issue list customization |
| **Custom board swimlanes** | **Yes** — no slot for board view customization |
| **Override core route** | **Yes** — route paths are additive only |
| **Modify core navigation shell** | **Yes** — no slot for shell-level changes |

---

## 10. Capability Summary Matrix

| Capability | Native Extension | Partial | Unsupported | Unknown |
|-----------|------------------|---------|-------------|---------|
| Sidebar contributions | ✅ | | | |
| Page contributions | ✅ | | | |
| Detail tab contributions | ✅ | | | |
| Dashboard widgets | ✅ | | | |
| Toolbar buttons | ✅ | | | |
| Comment annotations | ✅ | | | |
| Real-time streams | ✅ | | | |
| Scoped API routes | ✅ | | | |
| Agent tools | ✅ | | | |
| Approval workflow UI | | | ❌ | |
| Issue list customization | | | ❌ | |
| Board view customization | | | ❌ | |
| Core route override | | | ❌ | |
| Navigation shell modification | | | ❌ | |

---

## 11. Architectural Contradictions

### 11.1 UI contributions are served from the plugin package, but there is no integrity check or content security policy
The frontend imports `index.js` from `/_plugins/{pluginId}/ui/index.js`. There is no Subresource Integrity (SRI) hash, no sandbox attribute on the import, and no Content Security Policy that restricts plugin scripts. A compromised plugin package could execute arbitrary code in the board operator's browser context.

**Severity:** Medium — requires plugin package compromise or malicious install.

### 11.2 `page` slot route paths are checked for collision at install time but not at runtime after uninstall/reinstall
`assertPageRoutePathsAvailable()` checks against installed plugins during install. If a plugin is uninstalled (soft delete, `status = 'uninstalled'`) and a new plugin claims the same route path, the check will pass because `listInstalled()` may or may not include uninstalled plugins depending on the query.

**Severity:** Low — reinstall is admin-controlled.

### 11.3 The `PluginUiSlotDeclaration` includes `order` but there is no evidence the frontend respects it
The `order` field is declared in the manifest type and extracted in `getPluginUiContributionMetadata()`, but there is no frontend code inspected that sorts slots by `order`. The frontend may use registration order or default ordering instead.

**Evidence:**
- `packages/shared/src/types/plugin.ts::PluginUiSlotDeclaration.order` — declared
- `getPluginUiContributionMetadata()` — includes `order`
- No frontend slot host code inspected that sorts by `order`

**Severity:** Low — cosmetic; may affect tab ordering.

---

*No other contradictions identified from current evidence.*
