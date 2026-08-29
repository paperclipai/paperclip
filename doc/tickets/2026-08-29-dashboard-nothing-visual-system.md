# Unify dashboard visual language with a tokenized Nothing-inspired dotted system

Date: 2026-08-29
Status: in progress — dashboard first slice aligned in the working tree; full application sweep is tracked in GitHub issue #31

## Problem

Dashboard surfaces currently mix neutral gray cards, blue live accents, Tailwind palette colors, bespoke gradients, and separate chart palettes. The result is visually inconsistent, especially between usage/quota tracking, metric cards, charts, alerts, and live-agent panels. The operator should read one coherent instrument panel.

## Direction

Use a restrained, Nothing-inspired operational language:

- black/white neutral surfaces and fine borders
- dot-matrix numerals for machine values
- a quiet dot grid as texture, used sparingly
- one semantic accent family for healthy/live, warning, and blocked/error states
- no decorative blue/gray drift between dashboard cards
- status meaning remains accessible in text and ARIA labels; color is supporting signal

All dashboard colors, spacing, typography, radii, shadows, and motion must resolve through the token layer in `ui/src/index.css`. Do not introduce component-local hex, RGB, arbitrary value, or one-off palette classes.

## Surfaces in scope

- usage quota and per-credential analytics
- active-agent/live-run panel
- circular and rectangular metric cards
- run, priority, status, and success-rate charts
- budget/empty/error notices
- recent activity, “needs you”, stalled-task, and recent-task lists
- optional Smoke Lab dashboard card

## Acceptance criteria

1. Light and dark dashboard themes use the same semantic roles and do not mix unrelated blue/gray card treatments.
2. Usage quota, charts, and metric cards share surface, border, grid, and display-number tokens.
3. Healthy/live, warning, and error states use the same semantic accent tokens across bars, dots, arcs, notices, and text.
4. The UI remains readable without color perception and keeps existing data/links/ARIA behavior.
5. `pnpm check:token-gates` reports no new dashboard violations.
6. Focused dashboard tests, UI typecheck, and build pass.

## First-slice implementation note

The working-tree pass centralizes dashboard roles in `ui/src/index.css` and applies them to quota/usage, metrics, charts, circular stats, live agents, alerts, activity/task lists, and the optional Smoke Lab card. It removes the dashboard-local blue/gradient treatments and keeps the existing data, links, and provider semantics unchanged.

Verified:

- `pnpm exec vitest run ui/src/components/ActivityCharts.test.tsx ui/src/components/DashboardQuotaCard.test.tsx` — 8 tests passed.
- `pnpm --filter @paperclipai/ui typecheck` — passed.
- `pnpm --filter @paperclipai/ui build` — passed, with existing font/pseudo-element/Rollup warnings.
- `pnpm check:token-gates` — no new violations in the touched dashboard files; existing repo-wide debt remains tracked by the app-wide sweep.

## Non-goals

This ticket does not change quota calculations, usage period semantics, API contracts, or provider behavior.
