# Shangrila Dashboard — Redesign & Branding Handoff

**Date:** March 31, 2026  
**Author:** Cursor agent session  
**Chat reference:** [Dashboard UIUX Redesign](70aa4695-a191-45ee-9d77-9c006e90f82e)

---

## Overview

Full dashboard redesign of the Shangrila UI (Paperclip platform), covering layout, component architecture, branding, and visual identity. Work progressed through four phases: layout redesign, card replacement, PredNet-inspired branding, and polish.

---

## 1. What Changed

### Layout & Information Hierarchy

The original dashboard had oversized agent run cards dominating the viewport, pushing metrics and charts below the fold. The redesign reordered sections:

1. **Brand header** (logo + product name + company name)
2. **Metric cards row** (4-column grid on xl, 2-column on smaller)
3. **Agent Runs** (compact expandable list)
4. **Charts** (4-column grid: run activity, priority, status, success rate)
5. **Plugin slot**
6. **Recent Activity + Recent Tasks** (2-column grid)

### New Components

| Component | File | Replaces |
|---|---|---|
| `OrgChartCard` | `ui/src/components/OrgChartCard.tsx` | "Agents Enabled" MetricCard |
| `SpendingChartCard` | `ui/src/components/SpendingChartCard.tsx` | "Month Spend" MetricCard |

**OrgChartCard** — Mini org chart visualization showing agent hierarchy tree built from `reportsTo` relationships. Displays up to 7 agents with icons, names, status dots. Shows total count + running/paused/error breakdown. Links to `/org-chart`.

**SpendingChartCard** — SVG area/line chart of daily spend over last 14 days. Fetches `financeEvents` via `costsApi.financeEvents()` and aggregates debit events by day. Shows total month spend, budget utilization badge (color-coded), metered vs subscription split, peak daily spend. Links to `/costs`.

### Agent Runs Accordion

The `ActiveAgentsPanel` was converted from a grid of fixed-height cards to a compact expandable list. Each run is a single row with chevron, status dot, agent identity, issue info, and timestamp. Clicking expands to show the transcript. Active runs get a left border accent and pulsing status dot.

### Transcript Stdout Fix

`TranscriptStdoutRow` in `RunTranscriptView.tsx` was rewritten:
- Line-by-line rendering with line numbers
- 8-line preview with "Show all N lines (M more)" toggle
- Proper container with terminal icon, line count badge
- Hover highlights per line

---

## 2. Branding — PredNet-Inspired

The visual identity draws from the PredNet brand reference (`KBase/brand-reference.html`), which establishes three design DNA influences:

1. **Swiss International Style** — Grid as structure, typography as hierarchy, color as signal
2. **Palantir Intelligence** — Muted until activated, intelligence-briefing tone
3. **F1 Live Timing** — Minimal chrome, maximum data, deltas not absolutes

### Typography

Fonts loaded via Google Fonts in `ui/index.html`:
- **DM Sans** (400–800) — Display, headings, body text
- **JetBrains Mono** (400–700) — Data values, numbers, labels

Wired into Tailwind via `--font-sans` and `--font-mono` tokens in `@theme inline` block.

### Color Palette (Dark Mode)

| Token | Hex | Usage |
|---|---|---|
| `--background` | `#0A0A0B` | Page background |
| `--card` / `--popover` | `#141416` | Card surfaces |
| `--secondary` / `--muted` / `--accent` | `#1C1C1F` | Raised surfaces |
| `--border` / `--input` | `#2A2A2E` | Borders |
| `--sidebar-border` | `#1F1F23` | Subtle borders |
| `--foreground` | `#F0F0F2` | Primary text (t1) |
| `--muted-foreground` | `#6E6E78` | Tertiary text (t3) |
| `--ring` | `#4A4A52` | Quaternary text (t4) |
| `--brand-accent` | `#DC2626` | Crimson red accent |
| `--brand-accent-hover` | `#EF4444` | Red hover state |
| `--brand-accent-muted` | `#7F1D1D` | Red muted/background |

### Label Style

Section headers and metadata labels use the PredNet convention:
```
text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-muted-foreground/50
```

### Accent System

- **Active agent runs**: Red left border (`border-l-brand-accent`) + red pulsing dot
- **Status dots**: Square for inactive, round+pulsing for active
- **Chart lines**: Red stroke with red gradient fill (`--color-brand-accent`)

### Border Radius

Restored to standard rounded values after brief experiment with sharp edges:
```css
--radius-sm: 0.375rem;
--radius-md: 0.5rem;
--radius-lg: 0.625rem;
--radius-xl: 0.75rem;
```

All dashboard cards use `rounded-xl`.

### Logo

Mountain silhouette image at `ui/public/shangrila-logo.png`, displayed as a 24×24 image in the dashboard header alongside the "Shangrila" wordmark.

---

## 3. Files Modified

### Core Theme
- `ui/index.html` — Font imports (DM Sans, JetBrains Mono)
- `ui/src/index.css` — Full color palette, font tokens, radius tokens, brand accent variables

### Dashboard Page
- `ui/src/pages/Dashboard.tsx` — Layout reorder, brand header, new card components, section header styling, removed unused imports (`DollarSign`, `Sparkles`)

### Components (New)
- `ui/src/components/OrgChartCard.tsx` — Mini org chart card
- `ui/src/components/SpendingChartCard.tsx` — Spending line chart card

### Components (Modified)
- `ui/src/components/MetricCard.tsx` — Monospace values, uppercase tracked labels, muted icon
- `ui/src/components/ActiveAgentsPanel.tsx` — Compact accordion rows, red accent instead of gold
- `ui/src/components/ActivityCharts.tsx` — ChartCard monospace labels
- `ui/src/components/transcript/RunTranscriptView.tsx` — Rewritten `TranscriptStdoutRow`

### Assets
- `ui/public/shangrila-logo.png` — Mountain logo

---

## 4. Data Dependencies

| Component | API | Query Key |
|---|---|---|
| OrgChartCard | Uses `agents` already fetched in Dashboard | `queryKeys.agents.list()` |
| SpendingChartCard | `costsApi.financeEvents(companyId, from, to, 500)` | `queryKeys.financeEvents()` |
| ActiveAgentsPanel | `heartbeatsApi.liveRunsForCompany()` | `queryKeys.liveRuns()` |
| Dashboard summary | `dashboardApi.summary()` | `queryKeys.dashboard()` |

---

## 5. Dev Environment

- **Package manager:** pnpm 9.15.4
- **Start command:** `pnpm dev` from `shangrila/` root
- **Server:** http://127.0.0.1:3100
- **Database:** Embedded Postgres (auto-managed, port 54329)
- **UI:** Vite dev middleware served through Express

### Quick Start
```bash
cd d:\dev\valctrl\shangrila
pnpm dev
# Server: http://127.0.0.1:3100
# API: http://127.0.0.1:3100/api
```

---

## 6. Known State / Notes

- The test company is named **"Test"** (visible in sidebar). This is a database value, not a code issue. Can be renamed via company settings or DB.
- Light mode colors were not updated — only dark mode was overhauled. Light mode still uses default shadcn/ui oklch values.
- The `financeEvents` query in SpendingChartCard fetches up to 500 events for the last 14 days. For high-volume deployments, consider adding a server-side daily aggregation endpoint.
- The old `--brand-gold` / `--brand-gold-dim` CSS variables no longer exist. Any code referencing them will get no color. All references in dashboard components have been migrated to `--brand-accent`.
