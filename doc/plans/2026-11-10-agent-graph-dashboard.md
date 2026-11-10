# Editable agent graph and customizable dashboard

Status: reference implementation behind two experimental flags that default to off.

## 1. Summary

1. **Agent graph.** The org view becomes a real graph canvas: pan, zoom, minimap, drag, box and multi-select, auto-layout in two directions, sticky notes, copy and paste, reporting-line changes, undo and redo, live agent status.
2. **Customizable dashboard.** Dashboard cards become widgets in a grid that each user can move, resize, remove, add and restore. Contextual rules bring widgets in while something needs attention.
3. **Layout persistence.** One small table and three routes store a validated, versioned layout per user, company and surface.

Governance does not move into the browser. Every action that changes the organization calls an existing governed route and asks for confirmation first.

## 2. Goals and non-goals

Goals:

- Keep today's behavior byte-for-byte when the flags are off.
- Stay smooth with 200 or more agents. One live event must not re-render the whole graph.
- Never place a secret in the clipboard, in a saved layout or in a hire request built from a copy.
- Additive schema only.

Non-goals for the MVP: see section 10.

## 3. Graph engine

| | `@xyflow/react` 12 | Cytoscape.js | Hand-written SVG (today) | Konva / canvas |
| --- | --- | --- | --- | --- |
| Licence | MIT | MIT | n/a | MIT |
| React integration | Native: nodes are React components | Imperative, needs a wrapper | Native | Imperative |
| Editing built in | Drag, box select, multi-select, connect, reconnect, minimap, controls, keyboard focus | Partial, through extensions | None | None |
| 200+ nodes | Viewport virtualization, memoized nodes | Very good (canvas) | Re-renders the whole tree | Very good |
| Nodes can reuse app components (avatar, status capsule) | Yes | No (canvas-drawn) | Yes | No |
| Maintenance | Active, large user base (n8n uses its Vue port) | Active | Ours | Active |
| Bundle | Measured below, lazy chunk | Larger, lazy | 0 | Medium, lazy |

Choice: `@xyflow/react`. It is the only option where nodes stay ordinary React components that reuse `AgentAvatar` and the status tokens, and where the editing interactions do not have to be written and maintained here.

Auto-layout:

| | Own forest layout | `@dagrejs/dagre` | `elkjs` |
| --- | --- | --- | --- |
| Licence | n/a | MIT | EPL-2.0 or GPL (not acceptable in an MIT project without review) |
| Unpacked size | 0 | about 1.4 MB | about 8.2 MB |
| Fits the problem | Exact: reporting lines are a forest | General DAG, more than needed | General, heavy, usually in a worker |
| 250 nodes | Linear time, well under a frame | Fine | Fine, asynchronous |

Choice: own layout (`ui/src/features/agent-graph/lib/auto-layout.ts`), about 150 lines, iterative, with wrapping for wide rows of leaf reports.

## 4. Dashboard grid

| | `@dnd-kit` + CSS Grid | `react-grid-layout` 2 | `gridstack` 14 |
| --- | --- | --- | --- |
| Licence | MIT | MIT | MIT |
| New dependency | No, already used by the kanban board and the sidebar | Yes, plus `react-draggable` and `react-resizable` | Yes, not React-native |
| Unpacked size added | 0 | about 0.5 MB plus peers | about 2.2 MB |
| Free placement with gaps | No. Order plus spans | Yes | Yes |
| Responsive | The same list in 4, 2 or 1 columns | Separate layouts per breakpoint | Built in |
| Keyboard | Sortable keyboard sensor, plus size steppers | Limited | Limited |
| Many widgets | Trivial | Fine | Fine |

Choice: `@dnd-kit` on CSS Grid with dense flow. The layout document is a list, which keeps the schema, the migration story and the mobile behavior simple.

## 5. Data model

```
company_user_ui_layouts
  id             uuid pk
  company_id     uuid not null -> companies(id) on delete cascade
  user_id        text not null
  surface        text not null            -- 'agent_graph' | 'dashboard'
  schema_version integer not null
  layout         jsonb not null
  created_at, updated_at timestamptz
  unique (company_id, user_id, surface), index (company_id)
```

Migration `0459_company_user_ui_layouts.sql`: one `CREATE TABLE`, one foreign key, two indexes. Nothing existing changes.

Agent graph layout, version 1:

```
{ schemaVersion: 1,
  direction: "TB" | "LR",
  viewport: { x, y, zoom } | null,
  positions: { [agentId]: { x, y } },        // manually moved nodes only
  hiddenAgentIds: string[],
  stickies: [{ id, x, y, width, height, text, color }],     // at most 200
  drafts:   [{ id, x, y, name, role, title, capabilities,
               adapterType, model, reportsTo, sourceAgentId }] }  // at most 50
```

Dashboard layout, version 1:

```
{ schemaVersion: 1,
  widgets: [{ instanceId, widgetId, w: 1..4, h: 1..6, config? }],   // at most 60, order is position
  contextualRules: { [ruleId]: boolean } }                            // absent means on
```

Both schemas are strict. Version handling lives in `packages/shared/src/validators/ui-layouts.ts`: `resolveAgentGraphLayout` and `resolveDashboardLayout` run the migration chain from the stored version to the current one and then validate. A layout from a newer version, or one that fails validation, resolves to `null` and the UI falls back to the default.

## 6. API

| Route | Purpose |
| --- | --- |
| `GET /api/companies/:companyId/ui-layouts/:surface/me` | The caller's stored layout, or `layout: null` |
| `PUT /api/companies/:companyId/ui-layouts/:surface/me` | Validate and upsert. Body `{ layout }` |
| `DELETE /api/companies/:companyId/ui-layouts/:surface/me` | Remove the caller's layout (restore default) |

- Authorization: `assertCompanyAccess`, then `assertBoard` with a user id. Agent keys get 403. A user can only read and write their own row.
- Validation: unknown surface is 404. A layout that fails the surface schema or exceeds 256 KiB is 400.
- Activity: none. A layout is a personal view preference, like the workspace presentation preference, which also writes nothing to the company activity log. The table keeps `updated_at`.

No existing route changed. The graph uses `PATCH /agents/:id` for reporting lines and `POST /companies/:id/agent-hires` for hires, exactly as the existing pages do.

## 7. Feature A: agent graph

- Entry points: the org view of the Agents page, and `/org` in the classic UI. Both check `enableAgentGraph` and lazy-load the graph chunk.
- Nodes: agent (name, title or role, adapter, status capsule, budget meter, pulsing ring while a run is live), sticky note (resizable, five colors), hire draft (dashed).
- Edges: reporting lines. An edge animates while the report has a live run. Dragging from a manager's handle to an agent, or dragging the manager end of an edge to another agent, proposes a reporting-line change.
- Side panel: status, adapter, manager, report count, budget, the five most recent runs, links, "Duplicate as draft", "Hide from graph".
- Editing: drag, Shift-drag box selection, Ctrl or Cmd click, group move, snap to a 16 px grid, Tidy up, direction toggle, "Keep manual positions", undo and redo (100 steps), a shortcut list in the toolbar.
- Persistence: saves are debounced by 1.5 s, skipped when nothing changed, and flushed on page hide.
- Performance: `syncNodes` and `syncEdges` return the previous node and edge objects when their inputs did not change. React Flow then skips those nodes. Viewport virtualization is on.
- Accessibility: nodes are focusable and labelled, arrow keys move a focused node, every pointer action has a button or key path except box selection and connecting by drag (reporting lines can be changed on the agent page).
- Dark mode: the canvas reads the app tokens through React Flow's CSS variables.

Governance summary:

| Action | What happens |
| --- | --- |
| Move, select, add note, hide, tidy | Local to the user's layout |
| Paste or duplicate an agent | A draft in the user's layout. No agent is created |
| Request hire on a draft | Confirmation, then the governed hire route. The server applies permissions and board approval |
| Change a reporting line | Client cycle check, confirmation, `PATCH /agents/:id`. The server repeats the checks |
| Delete on an agent | Refused with an explanation |
| Pause, resume, terminate | Not on the canvas. A link opens the agent page |

## 8. Feature B: customizable dashboard

- Entry point: the Dashboard page, when `enableCustomizableDashboard` is on. Banners, onboarding, the Smoke Lab card and the plugin slot are unchanged and stay outside the grid.
- Registry (`ui/src/features/dashboard-grid/registry.tsx`): each widget declares `id`, `title`, `description`, `dataSource`, `defaultSize`, `minSize`, optional `settings`, and a lazily loaded component.
- Widgets: the existing cards (Agents panel, four metrics, Run Activity, Tasks by Status, Success Rate, Tasks by Priority when its UI flag is on, Recent Activity, Recent Tasks) plus Live Runs, Agent Errors and Pending Approvals.
- Edit mode: drag handle (pointer and keyboard), width and height steppers, a corner resize handle, widget settings, remove, Add widget (catalog), Restore default.
- Responsive: four columns from 1280 px, two from 768 px, one below. A span never exceeds the column count, so widgets stack on a phone.
- Contextual rules, each with its own switch: live runs, agent errors, pending approvals. When a rule's signal is on and its widget is not on the dashboard, the widget appears at the top, marked "Shown automatically", with "Pin to dashboard". It leaves when the signal ends unless pinned. When the widget is already placed, it gets a highlight ring instead.
- Data: widgets read the shared query keys. There is no per-widget timer. Signals come from the dashboard summary, the live-run list and the agent list, all of which the realtime provider already refreshes.

## 9. Feature flags and rollout

- `enableAgentGraph`, `enableCustomizableDashboard`: experimental settings, tier `preference`, default off everywhere, toggled on the Experimental settings page.
- Rollback is turning the flag off. Saved layouts stay in the table and are ignored.

## 10. Test plan

| Layer | Coverage |
| --- | --- |
| Shared | Layout schemas, byte and count limits, rejection of unknown keys (including `adapterConfig` and `env` on drafts), version migration, fallback to `null` |
| Server | Route authorization (other company, agent caller), validation, no company activity entry, reset. Service against embedded PostgreSQL: upsert, isolation between users and companies, cascade on company delete. This also runs the new migration |
| Graph logic | Cycle detection (including already-broken data and a 5,000-deep chain), layout (no overlaps for 250 agents in both directions, wrapping, cycles, deep chains), clipboard (allowlist, round trip, tampered payloads, capacity, name uniqueness), history |
| Graph component | 250 agents in jsdom: all render; a status change re-renders exactly one node; a refetch with equal data re-renders none; paste creates a draft and no agent; hire needs confirmation and sends only allowlisted fields. A render counter throws above its limit |
| Dashboard logic | Layout operations, limits, normalization, settings bounds, contextual rule resolution, pinning, signals |
| Dashboard component | Default, invalid and migrated layouts; contextual widget appears, leaves and stays when pinned; highlight instead of duplicate; rule off; edit mode produces one debounced save with the expected document; restore calls the reset route |

Not covered: committed Playwright e2e specs and Storybook visual baselines. The repository keeps both opt-in.

## 11. Pull request plan

Each PR starts from `upstream/master`. Later PRs stack on earlier ones until those merge.

1. **UI layout persistence.** Table, migration, shared schemas, service, routes, tests, API docs. No UI.
2. **Agent graph, read-only.** Flag, dependency, canvas, nodes, auto-layout, live status, side panel, saved positions and viewport.
3. **Agent graph editing.** Sticky notes, clipboard and hire drafts, reporting-line changes, undo and redo, shortcuts.
4. **Dashboard grid.** Flag, registry, existing cards as widgets, edit mode, saved layout.
5. **Contextual widgets.** Live Runs, Agent Errors, Pending Approvals, rules and pinning.

Before PR 1: post the issue draft and raise it in Discord `#dev`, as `CONTRIBUTING.md` requires for features.

## 12. Next steps outside the MVP

- Frames or groups on the graph.
- A toggleable layer of work edges (delegation, task assignment) with animation while a run is active.
- Shared, published company layout for the graph, with a permission for who may publish.
- Right-click context menu on the canvas.
- Lifecycle actions on nodes (upstream issue #14602), with their confirmations.
- "Group by project" and collapsible subtrees (upstream issues #16551 and #17102).
- More widgets: cost and budget, attention feed, tasks by status list, upcoming routine runs, mini agent graph.
- Plugin `dashboardWidget` contributions as registry entries.
- Several dashboards or presets per user.
- i18n keys once the app adopts them (upstream PR #16902).
- Playwright e2e for both surfaces and Storybook stories with visual baselines.

## 13. Open questions for maintainers

1. Per-user layout saves and resets write no company activity entry, following `workspace-preferences`. The route rule asks for an entry for each mutation of company data. Is this exemption acceptable, or should the first save of a layout be logged?
2. Is `@xyflow/react` acceptable as a UI dependency? It loads in its own chunk, only when the flag is on.
3. Is a core feature the right home, or should the dashboard grid start as a plugin surface?

## 14. Measured impact

Production build of `ui` (`vite build`), `upstream/master` against this branch, same machine:

| | Before | After | Change |
| --- | --- | --- | --- |
| Main entry chunk, raw | 3,709,631 B | 3,710,539 B | +908 B |
| Main entry chunk, gzip | 1,119,170 B | 1,119,442 B | +272 B |
| All JS chunks, raw | 19,244,165 B (387 files) | 19,478,351 B (399 files) | +234 KB, all in lazy chunks |

New lazy chunks:

| Chunk | Raw | Gzip | Loaded when |
| --- | --- | --- | --- |
| `AgentGraph` (includes `@xyflow/react`) | 180.3 KB | 58.5 KB | `enableAgentGraph` is on and the org view opens |
| `AgentGraph` CSS | 17.4 KB | 3.0 KB | Same |
| `DashboardGrid` | 20.1 KB | 6.8 KB | `enableCustomizableDashboard` is on and the dashboard opens |
| Widget chunks (4) | 8.7 KB | 3.5 KB | A widget of that group is on the dashboard |

With both flags off, a user downloads 272 more gzip bytes than today.

Runtime with 250 synthetic agents (jsdom, `AgentGraph.test.tsx`): one status change re-renders one agent node; a refetch that returns equal data re-renders none. Layout of 250 agents is a single linear pass (`auto-layout.test.ts`, both directions, no overlaps).

Browser smoke: a throwaway local instance (embedded PostgreSQL, 13 demo agents, both flags on) was driven with headless Chrome. The dashboard grid, edit mode, catalog, mobile stacking, the graph in light and dark mode, the side panel, a hire draft, a sticky note, the hire confirmation, the left-right layout and layout persistence across a reload all worked with no console errors. No frame-rate measurement with 200 or more agents was taken in a real browser. The 250-agent evidence is the render-count test.
