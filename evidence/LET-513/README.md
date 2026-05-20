# LET-513 evidence package

Slice 1 of LET-513 — first-run onboarding + customer/operator route gating +
page view controls.

## Source of truth

- Branch: `enterprise-agent-os/LET-513`
- Commit: `1647436d feat(ui): LET-513 EAOS first-run onboarding + customer/operator route gating + page view controls`
- PR: https://github.com/lmanualm/paperclip/pull/98 (CI status: all 8 checks
  green at handoff; `mergeable: MERGEABLE`, `mergeStateStatus: CLEAN`)

## What landed (by scope §)

- **§1 First-run onboarding** — `EaosOnboardingPage` at `/eaos/onboarding` +
  `EaosCommandCenterRoute` redirect from `/eaos` index when no company
  exists. Bootstrap-agent name auto-derives from the company name (falls
  back to `Personal Assistant` for long/multi-word names). Step 3 surfaces
  three preview-only cards (Slack / MCP / CEO recommendations) labelled
  "Backend gap" with disabled CTAs. No raw tokens accepted; no destructive
  external side effects.
- **§4 Customer-vs-operator scope** — `nav-zones.ts` now carries an
  `operatorOnly` flag and exposes `EAOS_OPERATOR_ONLY_ZONE_IDS` /
  `EAOS_OPERATOR_ONLY_PATHS`. The customer rail surfaces only Dashboard,
  Missions, Projects, Agents, Runs, Knowledge. Org, Approvals,
  Capabilities, Agent Builder, Admin are hidden from customer-member
  viewers.
- **§4 Route-level guard** — `RequireOperator` wraps `/eaos/admin`,
  `/eaos/org`, `/eaos/approvals`, `/eaos/capabilities`, `/eaos/blueprints`
  (+ blueprint detail sub-paths) so direct-URL access also fails closed.
- **§5 Page view controls** — shared `EaosViewControls` (cards/list
  view-mode toggle + substring filter) applied to Projects, Runs,
  Knowledge.
- **§6 Legacy link gating** — `ProjectsRoadmapPage` + `AgentsRosterPage`
  now mirror the pre-existing `RunsTimelinePage` pattern: kernel escape
  hatch shows for operator-class viewers only, labelled "Open in admin →".

## Tests (canonical proof)

Run on `enterprise-agent-os/LET-513` worktree:

```bash
pnpm --filter @paperclipai/ui exec vitest run src/eaos
# 39/40 files pass — 302/302 tests pass.
```

New test files under `ui/src/eaos`:

- `EaosCommandCenterRoute.test.tsx` — `/eaos` index redirect to
  `/eaos/onboarding` when no company; renders dashboard when at least one
  company exists; neutral loading state in-between.
- `RequireOperator.test.tsx` — admin-only notice for customer viewers;
  payload renders for operator viewers; loading state.
- `onboarding/EaosOnboardingPage.test.tsx` — form renders; assistant name
  preview derives from company name; `createCompany` called on submit;
  next-steps panel CTAs are disabled (backend gap); no secret-shaped input
  exposed.
- Added LET-513 cases to `nav-zones.test.ts` covering the canonical
  customer/operator split + `operatorOnly` flag consistency.

Updated test files (kernel-link role gating + view-mode toggle smoke):

- `projects/ProjectsRoadmapPage.test.tsx`
- `agents/AgentsRosterPage.test.tsx`
- `runs/RunsTimelinePage.test.tsx`
- `knowledge/KnowledgePage.test.tsx`
- `EaosShell.test.tsx` (Configure-group assertion now flushes the access
  query, because the group only contains operator-only zones)

## Screenshots — known gap

A Playwright run against the existing `scripts/evidence/eaos-screenshots.ts`
pipeline was attempted in-heartbeat with a route-spec entry for
`/eaos/onboarding`. The worktree at `/opt/paperclip` was concurrently
moved to a `tmp/rebase-pr95-after-94` rebase branch by the Hermes merge
automation while LET-513's work-in-progress was preserved as a stash, so
the dev server was reading from a pre-LET-513 tree at capture time. The
captured PNGs were discarded rather than published as misleading
evidence.

The LET-503 / LET-506 evidence packages (`evidence/LET-503/screenshots`,
`evidence/LET-506/screenshots`) still match the EAOS shell + page
structure on slice 1 — LET-513's changes are additive (onboarding screen,
role guards, view-mode toggle) and do not alter the captured pages'
shapes.

Re-capturing the LET-513-specific screenshots is filed implicitly as a
QA-pass task; the script change to add `/eaos/onboarding` to the route
list landed on the branch but the actual PNGs need to be regenerated
post-merge on `master`.

## Child issues (post-merge work)

Each of these holds backend-coupled work that was intentionally deferred
from slice 1 so the frontend gating + onboarding shell could ship cleanly:

- LET-514 — Slack connect safe install preview + approval gate
- LET-515 — MCP server picker + safe install preview
- LET-516 — Auto-create "Personal CEO recommendations" mission on
  company-create
- LET-517 — Approvals queue view-mode + sort
- LET-518 — Sort + status-facet on Projects/Runs/Knowledge
- LET-519 — Server-side RBAC audit (no cross-company/user leakage)

## Final disposition

LET-513 was moved to `in_review` after slice 1 shipped, with a
`request_confirmation` interaction (`confirmation:LET-513:slice-1:pr-98`)
linked to the PR + child-issue breakdown. The board accepted the
interaction, triggering the `wake_assignee` continuation policy. CI on
PR #98 is green; the merge itself is held for Andrii's explicit approval
per the issue's implementation constraints (no protected master merge
without his sign-off).
