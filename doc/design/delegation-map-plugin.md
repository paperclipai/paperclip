# Design Doc — Delegation Map plugin (SOP visibility, phase 0)

Status: **proposal, awaiting feedback** · Author: Claude (with Chrysler) · Date: 2026-06-01
Scope: paper-dev (fork `dev` branch) first, personal-tool-first.

---

## 1. Why this exists (the problem in one paragraph)

An "SOP" in Paperclip is not a document — it's a **delegation shape that should repeat**
("how we ship end-to-end with QA across N agents"). Today that shape exists in two forms
that never meet: the **intended** SOP (free-text prose in skills + each agent's `AGENTS.md`
bundle) and the **actual** SOP (a structured, already-indexed execution trace in core tables).
Nothing joins them, so you can't *see* how a task actually delegated, and you can't tell when
a run didn't follow the SOP. This plugin makes the **actual** delegation visible first —
the cheapest, highest-signal step — so the CEO (who configures SOPs/org) gets feedback from
reality instead of guesses.

Non-goal for this phase: authoring SOPs, enforcing them, or running live multi-agent tests.
Those are later phases that *build on* this one (see §9).

## 2. What you get (user-facing)

A read-only **Delegation Map**: pick a task (root issue or goal) and see the real graph of
who-delegated-to-whom, which sub-tasks spawned, what blocked what, which agent actually
executed each step, and whether it reached a "done"/review state.

```
Task PAP-123 "Ship feature X" — actual delegation (reconstructed)
  ┌─ CEO ───────────────▶ PM ──────────▶ Engineer ──▶ QA   [in_review]
  │  (created)            (assignee)      │            └─ blocks ─▶ Release
  │                                       └──▶ Designer [done]
  └ legend: ─▶ delegated (parent→child) · ⟂ blocks · ◇ executed-by (runs)
```

Three surfaces (all standard plugin UI slots):
1. **`ui.page`** `/<company>/delegation-map` — pick a goal/issue, render the full graph.
2. **`ui.detailTab`** on an **issue** — "Delegation" tab showing that issue's subtree graph.
3. **`ui.dashboardWidget`** — "tasks with the deepest/widest delegation this week" tile.

## 3. Why a plugin (not core)

- **Zero core schema, zero migration, fully reversible** (uninstall = drop the plugin's
  private Postgres namespace; agents untouched). Right blast radius for a personal-tool instance.
- Rides entirely on shipped first-party primitives already exercised by
  `plugin-orchestration-smoke-example` and `plugin-llm-wiki`.
- Keeps SOP source-of-truth where it belongs (skills + `AGENTS.md`) — this is a **lens**, not a new authoring model. (See §8 on source-of-truth.)

## 4. Architecture

```
 ┌─────────────────────────────────────────────────────────────┐
 │ Delegation Map plugin                                        │
 │                                                              │
 │  worker.ts  ──ctx.db.query()──▶ public.issues / issue_       │
 │   (server)                       relations / heartbeat_runs / │
 │     │                            agents   (read-only JOIN)    │
 │     │ ctx.data.register("graph", …)                           │
 │     ▼                                                         │
 │  ui/index.tsx  ──usePluginData("graph")──▶ <DelegationGraph/> │
 │   (React page / tab / widget)                                │
 └─────────────────────────────────────────────────────────────┘
```

No plugin-owned tables are required for phase 0 (pure read + reconstruct on demand).
An optional cache table in the plugin namespace can come later if graph builds get slow.

### Manifest (sketch, modeled on the smoke example)

```ts
const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.delegation-map",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Delegation Map",
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  capabilities: [
    "issues.read", "issue.subtree.read", "issue.relations.read",
    "agents.read", "database.namespace.read",
  ],
  database: {
    namespaceSlug: "delegation_map",
    migrationsDir: "migrations",            // empty for phase 0 (no owned tables yet)
    coreReadTables: ["issues", "issue_relations", "heartbeat_runs", "agents", "goals"],
  },
  ui: { slots: [
    { type: "page",            id: "map",   displayName: "Delegation Map", routePath: "delegation-map", exportName: "MapPage" },
    { type: "detailTab",       id: "tab",   displayName: "Delegation",     entityTypes: ["issue"], exportName: "IssueDelegationTab" },
    { type: "dashboardWidget", id: "tile",  displayName: "Delegation Depth", exportName: "DepthWidget" },
  ]},
};
```

All `coreReadTables` above are confirmed members of `PLUGIN_DATABASE_CORE_READ_TABLES`
(`packages/shared/src/constants.ts:852`).

## 5. The reconstruction (the heart of it)

Given a root (issue id or goal id), build a graph from data that already exists:

**Nodes**
- One node per **issue** in the subtree: walk `issues.parent_id` from the root
  (or all issues with `goal_id = :goal`). Fields: `id, title, status, assignee_agent_id, created_by_agent_id`.
- One node per **agent** that appears (resolved from `agents`: `id, name, role, reports_to`).

**Edges**
- **delegated** — `child.parent_id → parent` (the subtask tree). Labeled with the
  creating agent (`child.created_by_agent_id`) → assignee (`child.assignee_agent_id`).
- **blocks** — `issue_relations` where `type='blocks'` (`issue_id` blocks `related_issue_id`).
- **executed-by** — link an issue to the agents that actually ran on it via
  `heartbeat_runs` where `context_snapshot->>'issueId' = issue.id` (this column is already
  indexed: `heartbeat_runs_company_issue_created_desc_idx`). This is what catches
  "declared owner was the PM, but the Engineer is who actually did the runs."

**Query shape** (worker, `ctx.db.query`, read-only; illustrative):
```sql
-- subtree issues (recursive on parent_id), company-scoped
WITH RECURSIVE sub AS (
  SELECT id, parent_id, title, status, assignee_agent_id, created_by_agent_id
    FROM public.issues WHERE id = $1 AND company_id = $2
  UNION ALL
  SELECT i.id, i.parent_id, i.title, i.status, i.assignee_agent_id, i.created_by_agent_id
    FROM public.issues i JOIN sub ON i.parent_id = sub.id
   WHERE i.company_id = $2
)
SELECT * FROM sub;
-- + a JOIN to issue_relations (blocks) and a per-issue heartbeat_runs roll-up.
```
(Typed `ctx.issues.getSubtree` / `ctx.issues.relations.get` exist too; raw SQL is used where a single round-trip JOIN is cleaner.)

**Output contract** (what `usePluginData("graph")` returns to the React UI):
```ts
type DelegationGraph = {
  root: { kind: "issue" | "goal"; id: string; title: string };
  issues: Array<{ id; title; status; assigneeAgentId; createdByAgentId }>;
  agents: Array<{ id; name; role; reportsTo }>;
  edges: Array<
    | { kind: "delegated"; fromIssueId; toIssueId; byAgentId; toAgentId }
    | { kind: "blocks";    fromIssueId; toIssueId }
    | { kind: "executedBy"; issueId; agentId; runCount }
  >;
  stats: { issueCount; agentCount; maxDepth; blockedCount };
};
```

## 6. Visualization

Reuse the **existing in-repo layout**, no new graph dependency:
- `ui/src/pages/OrgChart.tsx` already implements a custom layered tree (card geometry,
  recursive subtree-width, zoom/pan, PNG export, touch-aware) — the Delegation graph is the
  same layered-DAG layout with issue/agent cards instead of org cards.
- `ui/src/lib/issue-tree.ts` (`buildIssueTree`, `countDescendants`) gives the parent→child
  scaffolding for free.
- Styling via the `design-guide` + `frontend-design` skills; status/priority token system
  for node badges. Mobile: the same viewport realities as the rest of the app — render a
  compact vertical list fallback under the mobile breakpoint (reuse `useIsMobileSafe`).

## 7. "Testing the SOP" — honest scope (read this)

This phase does **not** test SOPs. When we get there (phase 2), be clear-eyed:
- A dry-run is a **structural/process** test (does the choreography fire in order, does the QA
  gate exist, every role resolves to a live agent, no deadlock), **never a semantic one** — a
  7-agent SOP can pass every assertion and still ship bad work, because no real output is judged.
- Real multi-agent runs are **non-deterministic**; a strict "actual must equal declared" diff
  produces **false-positive drift** on acceptable variation (an agent sensibly spawning an extra
  subtask). Any detector needs soft/advisory edges + tuning, or it becomes notification spam.
- A faithful live N-agent simulation **costs tokens** — it's a pre-merge gate run on SOP change,
  not on every commit, and needs a guardrail (dryrun billingCode/originKind) so it never wakes
  real agents on real budget.
- What testing *can* honestly promise: static validity + retrospective drift on real runs
  (§9 phase 2). That's ~80% of the safety for ~5% of the cost.

## 8. Source of truth — answering "is AGENTS.md P0, SOP.md P1?"

Important correction: a loose `SOP.md` would **not** be reliably loaded. Agents load their
**managed `AGENTS.md` bundle** and **assigned skills** every run (guaranteed by the harness via
`paperclipSkillSync`); an arbitrary `SOP.md` is not in that path. So:
- **Keep SOPs as prose in skills (preferred) or `AGENTS.md`** — both auto-load every run.
- **Do not introduce a `SOP.md`** as the carrier; it's *less* reliable than what exists.
- This plugin treats that prose as canonical and only *reflects reality back*; it never becomes
  a competing source of truth. (A future "declared SOP overlay" parses that same prose — it still
  doesn't move the source of truth.)

## 9. Phasing

- **Phase 0 (this doc): Delegation Map** — visualize *actual* delegation. Effort ~L. No schema.
- **Phase 1: Declared-SOP overlay** — parse skills/`AGENTS.md` into a step/delegation graph and
  overlay declared-vs-actual; drift shows as colored divergences. Effort ~M. Still no core schema
  (plugin namespace cache, rebuildable from source). Gated on Phase 0 teaching us the real
  parsing conventions.
- **Phase 2: Validate / test / enforce** — static SOP validation, optional sandbox dry-run,
  retrospective drift → tracked issue. Effort L–XL. Decide only after living with 0–1.

Phase 0's reconstruction is the literal foundation Phases 1–2 reuse (drift = diff against it),
so it is never throwaway.

## 10. Open product questions (for the CEO / you)

1. **Authoritative direction** — keep SOP prose canonical and visualize/validate (this path), or
   later make a structured SOP entity the source that `AGENTS.md` is generated from? (Leaning
   prose-canonical, per personal-tool/low-burden constraints.)
2. **See vs. prevent** — is the job "show me what happened so I can coach the CEO" (visualization,
   this phase) or "block a `done` when the QA step was skipped" (enforcement, riskier, later)?
3. **Drift tolerance** — when an agent improvises a sensible extra subtask: signal or noise?
   Default proposal: drift is **advisory + rolled up** (a tile, not a per-event ping) until proven
   precise on the real corpus — matches the "no notification spam" preference.

## 11. Risks / cons (honest)

- Reconstruction quality depends on agents consistently using `parentId`/`goalId`/assignment;
  delegation that happens purely via adapter sessions (`agent_task_sessions`, not in the plugin
  read allowlist) is invisible to phase 0.
- `executed-by` via `context_snapshot->>'issueId'` is only as good as that snapshot being set
  (it is, on the indexed hot path, but older/edge runs may lack it).
- Graph readability degrades for very large subtrees; needs depth/expansion controls (the
  IssuesList tree already faced this — reuse its render-cap idea).
