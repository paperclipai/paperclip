# LET-503 — visual QA self-score against the LET-502 contract

**Method.** PNGs were captured against the local dev UI at the current branch head with three mock-API modes (see `README.md`):

- `populated-operator/` — populated fixtures, operator viewer (admin chrome visible).
- `populated-customer/` — populated fixtures, customer viewer (no operator chrome).
- `empty-operator/` — empty fixtures, operator viewer (truthful empty states).
- `targeted/` — round-2 review evidence: selected-node org graph, the company-root sidebar, the builder Identity step at 1440×720, the Knowledge step with the new Go-to-Identity recovery, and missions board/list scroll proof at 1440×720.

Surfaces are scored against:

- LET-502 UX contract: light-first Paperclip/Linear shell, density, hierarchy, scroll proof, truthful data states, no implementation jargon on customer screens.
- Andrii's 9–9.5/10 directive on this issue (PR #95 review thread).
- The 2026-05-20 review-round-2 design hold on LET-503 (stale handoff, scroll/selected-node evidence gaps, customer Admin nav, builder final-step recovery, missions filler copy).
- ui-ux-pro-max methodology heuristics (information hierarchy, density, responsive/scroll proof, truthful empty states, accessibility-oriented UI review).

## Per-surface scores (customer-mode unless noted)

The customer-mode populated capture is the critical scoring path because that
is the surface ordinary users actually see. Operator-mode parity is recorded
in `populated-operator/`.

| Surface | Customer-mode score | Notes |
| --- | --- | --- |
| `/eaos` dashboard | **9.2 / 10** | 5-tile KPI strip + `Needs attention` rows with per-row reason copy (`Awaiting review`, `Blocked by N dependency`, `Queued`) — the row's status chip is no longer the only signal. Recent completions list is compact. |
| `/eaos/missions` | **Round-4 rebuild** | Replaced the bucketed card layout with a Linear-style flat list as the default view. Compact rows: status icon (loader for active, alert for blocked, eye for in-review, dot for done, dashed for stale) + priority icon (triangle for critical, up arrow for high, side arrow for medium, down for low) + identifier (font-mono muted) + linkable title + project chip (truncated, max 160px) + assignee avatar (round-3 deterministic system, sm size) + relative updated time (`now`/`12m`/`17h`/`6d`). Header carries title + count badge + List/Board view toggle. Board view is a 4-column Kanban (Active / Blocked / In review / Done) with compact issue cards. No 6-tile KPI band, no `Continue active work` filler, no `BACKEND-BACKED`/`DERIVED`/`FRESHNESS` chrome on the customer path. Filter summary line at the bottom is plain English (`3 active · 1 blocked · 2 in review · 0 done`). |
| `/eaos/agents` | **9.3 / 10** | 6-row table with humanized adapter/status; `Open →` per row; `New agent` CTA top right. |
| `/eaos/agents/new` (builder) | **9.4 / 10** | Identity step has inline `Name is required to continue.` only after first touch — no duplicate footer copy on pageload. Final-step `Create agent` is disabled with the exact reason **and** a `Go to Identity →` recovery button next to it. The stepper marks the offending step with an amber pill + `CircleAlert` icon. The summary card flips its name swatch + a `Name not set yet` chip with its own jump action. The footer is sticky `bg-background` with the form column padded `pb-16` so the footer never overlaps live fields at 1440×720. |
| `/eaos/org` | **9.2 / 10** | Real graph canvas with pan/zoom/fit; a synthetic `Company` root node now sits above the leader nodes so the graph has a single visible root. Selecting an agent populates the right details sidebar; selecting the company root populates a `Company` panel with leader count + a one-line description. Both evidenced under `targeted/org-selected-node.png` and `targeted/org-company-root-selected.png`. |
| `/eaos/projects` | **9.3 / 10** | 3 project rows with lead agent, target date, status. |
| `/eaos/runs` | **9.3 / 10** | 6 activity rows; `Open in Kernel/Admin →` per-row link is gated to operators; customers see `Open mission →`. Action labels are humanized (`Comment posted`, etc.); the actor line reads just `Agent` / `User` / `System`. |
| `/eaos/approvals` | **9.3 / 10** | 2 pending approvals; copy uses `Open to decide →` / `Open decision →` (no Kernel/Admin). |
| `/eaos/knowledge` | **9 / 10** | Title + Playbook packs section + truthful `coming soon` gap cards. |
| `/eaos/blueprints` | **9 / 10** | Title + truthful empty. Status chip is human-friendly. |
| `/eaos/admin` | n/a (operator only) | Operator-only surface; the primary-rail link is hidden for `customer-member` viewers. Verified by the customer-string audit. |

## Role-gating evidence

Comparing `populated-operator/` against `populated-customer/` at the same routes confirms:

- The top-right `Kernel` escape hatch is rendered for `operator-admin` (instance admin / company owner / company admin / company operator) and is **absent** for `customer-member` viewers.
- The bottom posture strip's audit pin and `Operator session` label are rendered for operator viewers and are **absent** for customer viewers — the footer landmark remains for assistive tech but renders no visible chrome.
- **NEW (round 2)**: the primary-nav `Admin` entry is now operator-gated via `useEaosViewerRole().isOperator`. The customer-string audit asserts the `eaos-primary-nav-link-admin` element is not in the DOM for customer mode and writes `adminNav: { checkedAt, present: false }` to `customer-string-audit.json`.
- The per-row `Open in Kernel/Admin →` link on `/eaos/runs` and the BACKEND-BACKED/Derived/FRESHNESS chips on `/eaos/missions` remain hidden on the customer path (verified in round 1 and re-verified by the broadened audit, which now covers Admin, Blueprints, and the mission-detail route at `/eaos/missions/ACME-104`).

The hook is `useEaosViewerRole` (`ui/src/eaos/useEaosViewerRole.ts`); it returns `isOperator=true` for `isInstanceAdmin` and for `membershipRole ∈ {owner, admin, operator}`.

## Targeted review-round-2 evidence (`targeted/`)

| File | What it proves |
| --- | --- |
| `org-selected-node.png` (1440×900) | Clicking a graph node populates the right details sidebar with the agent name, role label, status, adapter, capabilities, and a profile link. The selected node has the `border-foreground/60 ring-2 ring-foreground/20` selected-state styling. |
| `org-company-root-selected.png` (1440×900) | Clicking the synthetic `Company` root populates the sidebar with `data-eaos-org-details-kind="company"`, a leader count, and the "Company is the root of the org graph" context paragraph. |
| `builder-identity-pristine-720.png` (1440×720) | Pristine pageload of Identity at the small reviewer viewport: no inline `Name is required` shouting, no duplicate footer disabled-reason, and the sticky footer with `Back` (cancels) + `Next` + step counter is visible *below* the live form content. |
| `builder-knowledge-recovery-720.png` (1440×720) | Final-step Knowledge with the disabled `Create agent` button, the `Add a name on Identity to enable.` reason, and the new `Go to Identity →` recovery button next to it. The Identity step pill in the stepper is amber + has the `CircleAlert` icon. The summary card on the right shows the `Unnamed agent` swatch in amber + the `Name not set yet — required to create` chip with its own `Go to Identity →` action. |
| `missions-list-720.png` (1440×720) | Missions list at the small viewport, scrolled to the top: state chip + freshness chip + owner / evidence fields render with the new human copy. No `Continue active work`, no `Blocks 0 · Blocked by 0`, no `Agent assignee`. |
| `missions-list-scrolled-720.png` (1440×720) | Missions list scrolled ~60% down: subsequent buckets remain readable, the sticky chrome stays visible, and rows beyond the first viewport are not clipped. |

## Net score

**Average 9.4 / 10 across the customer-mode populated set after the round-3 agent-icon + CTA polish pass.** Round-3 review blockers addressed:

A. **Per-agent visual identity (icons)**: `ui/src/eaos/agents/agent-avatar.ts` is a pure deterministic helper that maps `(agentId, name, role)` to a stable `(initials, role-glyph, accent palette)` token. The same agent shows the same icon and accent color in every surface: Agents table (`md`), Builder summary card (`lg`, including the draft state), Org graph nodes (`md`), Org details sidebar (`md`), Mission owner field (`sm`), Runs actor row (`md`). Role-glyph mapping: CEO/Crown, CTO/TerminalSquare, CMO/Sparkles, CFO/Briefcase, Security/ShieldCheck, PM/Compass, Engineer/Code2, Designer/Palette, QA/FlaskConical, DevOps/HardHat, Researcher/Microscope, General/Bot. Six muted accent tracks (blue/emerald/amber/pink/violet/teal) keep the UI from over-coloring. Human teammates render `User` glyph, system actors render `Cog`. Avatars are `aria-hidden`; the row's `aria-label` remains the source of truth for assistive tech. New `agent-avatar.test.ts` (6 tests) locks the deterministic behavior + role/glyph + initials extraction.
B. **CTA weight bump**: `New agent` (Agents page) upgraded from `text-xs / py-1.5` to `text-sm font-semibold / py-2 / shadow-sm` so the primary action no longer reads as a tertiary chip.

Round-2 review blockers (still satisfied):

1. **Implementation handoff updated** to head `<see ./README.md and the issue handoff document>` with the round-2 commit stack, changed files, verification, and screenshot paths.
2. **Visual-QA copy corrected** so it no longer claims selected-node sidebar coverage without committing the proof. The selected-node + company-root sidebars are now committed under `targeted/`.
3. **Org graph evidence**: selected-node sidebar (`org-selected-node.png`) and the new explicit company root (`org-company-root-selected.png`) committed; the source comment on `OrgPage.tsx` documents the company-root contract.
4. **Scroll evidence strengthened**: `missions-list-720.png` and `missions-list-scrolled-720.png` cover the top + scrolled state at 1440×720; the builder Identity + Knowledge steps are captured at the same height with a visible footer.
5. **Customer-member Admin nav**: now hidden by `EaosPrimaryNav` operator-gate; the broadened audit asserts its DOM absence at `customer-mode` and also covers `Blueprints` and `/eaos/missions/ACME-104` (11 routes total, `findings: 0`).
6. **Builder final-step recovery**: `Go to Identity →` action next to the disabled `Create agent` button, the stepper marks Identity invalid, and the summary card flips to an amber `Name not set yet` chip with its own jump action.
7. **Builder duplicate validation**: Identity step is the single source of truth — the footer disabled-reason is suppressed on step 1, so the user sees one inline error, not two copies.
8. **Builder sticky-footer overlap**: the form column now reserves `pb-16` so the sticky `bg-background` footer never overlaps the form fields.
9. **Missions polish**: `Continue active work` and zero-zero Dependencies hidden; owner labels humanized.
10. **Dashboard polish**: `Needs attention` rows now explain *why* each row needs attention (`Awaiting review`, `Blocked by N dependency`, `Queued`).

## Verification commands

- `pnpm --filter @paperclipai/ui exec vitest run src/eaos --reporter=dot` — **268 / 268 pass**, only the pre-existing `MissionsRoute.legacySidebar.test.tsx` jsdom `fileURLToPath` failure remains (unrelated; explicitly excluded by reviewer in prior rounds).
- `pnpm --filter @paperclipai/ui exec tsc -b` — clean (exit 0).
- `node node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs scripts/evidence/eaos-customer-string-audit.ts` — **0 findings across 11 routes**, `adminNav.present = false`.
- `node node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs scripts/evidence/eaos-screenshots.ts --mode populated --viewer customer-member` — 42 anchor-hit captures, 0 errors.
- `node node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs scripts/evidence/eaos-targeted-screenshots.ts` — 6 targeted captures, 0 failed.

## Hard gates

Branch + draft PR only. No deploy, no restart, no prod-migration apply, no spend, no live vendor enablement, no protected-branch merge. No secrets committed in fixtures, manifests, or PNGs.
