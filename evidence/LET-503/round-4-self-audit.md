# LET-503 round-4 — self-audit against Andrii's Telegram reference contract

Per the final-iteration warning in comment `a0f09724`, this is the per-surface self-audit. Each row maps a surface to either the round-4 fix landed in this commit OR an explicit remaining gap. I am not hiding gaps.

Anchor: branch head after this commit on `enterprise-agent-os/LET-504`. PR #95.

| # | Surface | Reference target (from issue description + Andrii's comments) | Round-4 state | Remaining gap |
| --- | --- | --- | --- | --- |
| 1 | Dashboard / command center | Compact KPI tiles + "Needs attention" / "What's running" / "Recent" lists, not a card-wall | Round-2 left the 5-tile KPI strip + Needs-attention rows + Recent-completed rail with per-row reason copy. **No round-4 rebuild yet.** | Andrii flagged the Dashboard as "not strong enough as a command center". Needs sharper state-grouped sidebar (Blocked / Running / Review) and stronger CTAs. **Tracked as remaining gap.** |
| 2 | Missions list + board + task detail | Linear-style flat list with status icon + priority + id + title + project + assignee avatar + updated; Kanban board for state view; central document + right sidebar for detail | **List view fully rebuilt** to Linear-style flat row table. **Board view added** as a 4-column Kanban with compact issue cards. Both share the round-3 agent avatars and the new status/priority icon vocabulary. | Mission **detail** page (4 tabs + heavy header) is still the LET-467 layout, not central-content + right-sidebar Linear style. **Tracked as remaining gap for the next round.** |
| 3 | Agents roster + agent surfaces | First-class list/table with name, status, workload, runtime, activity, runs; per-agent visual identity | Round-3 wired the deterministic per-agent avatar at the row level; columns renamed (`Adapter`→`Runtime`, `Last heartbeat`→`Last seen`); humanized status; `New agent` CTA upgraded to heavier weight. | No detail/inspector overlay slice yet. **Tracked as remaining gap.** |
| 4 | Agent Builder | 6-step manual create with summary card, sticky footer, recovery actions, deterministic identity preview | Round-2 + round-3 landed: required-name validation, `Go to Identity →` recovery, sticky `bg-background` footer, amber `CircleAlert` invalid step pill, summary card avatar swatch using the same deterministic primitive. | Builder Name field doesn't auto-focus when user clicks `Go to Identity →`. **Tracked as remaining polish gap.** |
| 5 | Org/team graph | Single visible root, agent nodes with per-agent icons, selected-node sidebar, pan/zoom/fit | Round-3 + round-2: synthetic `Company` root node prepended (so the graph has one visible root), per-agent avatars on every node card, selected-node sidebar populated, company-root sidebar populated, pan/zoom/fit controls visible. Both states captured in `targeted/`. | Edges are still thin SVG lines. Selected-node ring could be more confident. **Tracked as polish gap.** |
| 6 | Projects roadmap | Minimal table | Existing buckets surface for 3 projects with lead agent + target date + status. **Round-4 has not yet rebuilt this** to Linear-style. **Tracked as remaining gap.** | — |
| 7 | Runs / activity timeline | Compact activity feed with actor + action + target + time | Round-3 wired the per-actor avatar at the row level, humanized action labels (`Comment posted`, `Test completed`, `Document updated`, `Blocked on dependency`), customer-only mission link, no debug-id suffix. | Layout is still card-grid (3 columns). Could be flattened to a Linear-style activity row stream. **Tracked as polish gap.** |
| 8 | Approvals queue | Compact rows with type / requester / decision affordance | Round-2 cleaned customer-path link copy (`Open to decide →` instead of `Open in Kernel/Admin →`). Two pending approvals render. | No Linear-style list rebuild yet. **Tracked as remaining gap.** |
| 9 | Knowledge / Skills / Blueprints | Clean table/form surfaces, not heavy marketing | Empty-state truthful "coming soon" cards. No fake packs, no marketing copy. | Surface is sparse — Andrii wants empty states to feel "intentionally designed", not skeletal. **Tracked as remaining gap.** |
| 10 | Customer-safe Admin / management | Operator-gated; not in the customer rail | Admin nav entry gated by `useEaosViewerRole().isOperator`; customer DOM does not include `eaos-primary-nav-link-admin`. Verified by `customer-string-audit.json` (`adminNav.present: false`). | The admin surface itself is operator-only, so no customer-facing rebuild needed. ✅ |
| 11 | Primary nav, top bar, headers, sidebars, empty states, drawers/modals, scrolling | Restrained Paperclip/Linear chrome; functional scroll | Round-2/3 trimmed the top bar to brand + company chip + search + profile + (operator-gated) Kernel hatch. Posture-strip footer is operator-only chrome. Empty states are truthful. Scroll proven at 1440×720 in `targeted/`. | Header type weight could be heavier; nav rail could be tighter. **Tracked as polish gap.** |

## What this round-4 commit ships

1. `/eaos/missions` **list view rebuilt** to Linear-style flat row table (single primary visual change).
2. `/eaos/missions` **board view added** as a 4-column Kanban toggle (cards reuse the round-3 avatar system).
3. `mission-resolver` extended with `priority` + `projectLabel` + `projectUrlKey` so the Linear-style row carries first-class signal.
4. Status icon vocabulary (Loader2 / AlertCircle / Eye / CircleDot / CircleDashed / CircleSlash / Circle) replaces the old text chips for the row primary state.
5. Priority icon vocabulary (AlertTriangle / ArrowUp / ArrowRight / ArrowDown / Minus) sits beside the status icon.
6. Tests rewritten to lock the Linear-style contract: default-mode is `list`, board toggle works, no backend tokens leak in customer mode, no mutating buttons, no filler copy.

## What this round-4 commit explicitly does NOT ship

- Mission **detail** page rebuild (LET-467 layout still in place).
- Dashboard command-center rework.
- Agents detail / inspector overlay.
- Projects / Runs / Approvals / Knowledge / Blueprints Linear-style row passes.
- Builder Name-focus on `Go to Identity →` jump.

These are tracked above as remaining gaps. I am not claiming the customer shell is finished.

## Evidence

- `populated-customer/` — 42 anchor-hit captures at the new head. New Missions list is the headline change; check `1440/eaos-missions.png`, `1920/eaos-missions.png`, `scroll/eaos-missions.png`.
- `targeted/` — re-shot. The `missions-list-720.png` capture now reflects the Linear-style row layout at the reviewer's small viewport.
- `customer-string-audit.json` — re-run at the new head. **0 findings across 11 routes**, `adminNav.present: false`. No backend tokens or operator chrome leaked in the new Missions DOM.

## Hard gates

Branch + draft PR only. No deploy / restart / prod migration / spend / live vendor / protected-branch merge.
