# TOKEN-AUDIT.md — Design Token Drift Audit (Phase 1)

Run scope: `ui/src/` only, on branch `design/token-extraction`. Read-only audit — no source files were modified. See `DESIGN.md` for the token layer contract and `PRIOR-ART.md` for prior findings (only 6/220 exact-mappable).

**Method:** ripgrep over `ui/src/**/*.{ts,tsx,css}`. Counts below are current as of this run (2026-07-06), not the PRIOR-ART numbers. Test files (`*.test.ts(x)`) are included in totals where noted but broken out separately — they are not shipped UI, but they do encode the same hardcoded values and will need companion updates if Phase 2 changes the values they assert against.

## Executive summary

| Category | Site count | Files | Existing-token exact matches |
|---|---:|---:|---:|
| Hex color literals (`#...`) | 206 (150 source / 56 test-only) | 51 | ~14 sites (case-insensitive match only — see below) |
| `rgb()/rgba()/hsl()/hsla()` literals | 52 | ~30 | 0 (all are opaque decorative gradients / canvas fills) |
| Tailwind arbitrary color brackets (`bg-[#..]`, `text-[#..]`, `border-[#..]`) | ~72 | ~10 | overlaps with hex count above (same literals, bracket-wrapped) |
| Tailwind palette utility classes (`bg-red-500`, `text-amber-600`, etc. — not literal hex but not project tokens either) | **3,115** | **145** | 0 (Tailwind's built-in oklch palette, never routed through `index.css`) |
| `text-[Npx]` arbitrary font-size | 730 | 137 | 0 |
| `tracking-[N em]` arbitrary letter-spacing | 202 | ~40 | 0 |
| `w-[...]` / `h-[...]` arbitrary size | 124 / 166 | ~60 combined | 0 (mostly px/rem/vh/dvh/calc, some `var(--radix-*)`) |
| `min-w/max-w/min-h/max-h-[...]` | 194 | ~45 | 0 |
| `p*/m*-[...]` arbitrary spacing | 14 | 9 | 0 (mostly `env(safe-area-inset-*)` and `calc(theme(spacing.N)-2px)`) |
| `gap-[...]` arbitrary | 8 | 2 | 0 |
| `rounded-[...]` arbitrary radius | 25 | 10 | 0 (4 of these are **stock shadcn registry values**, not local drift — see below) |
| `shadow-[...]` arbitrary shadow | 38 | 21 | 0 |
| inline `style={{ }}` literals with a hardcoded value | ~90 sites across 58 files | 58 | see cross-ref |
| Chart/status color constant arrays (`.ts`) | 6 files, ~35 distinct hex | 6 | 1 partial (`#2563eb`) |

Total distinct hardcoded-value **sites** (excluding the 3,115 Tailwind-palette-class sites, which are reported separately because enumerating each is not useful) is roughly **1,550** across color/spacing/radius/type/shadow categories. Including the Tailwind palette-class sites, the true "every visual value should be a token" count DESIGN.md principle 2 implies is **~4,650+**. This is far larger than PRIOR-ART's ~220 — either the codebase grew substantially since that audit, or that audit undercounted Tailwind arbitrary values and palette classes (it reported "~193 color / 23 radius / 7 type" — consistent with counting only hex/oklch color literals and rounded-brackets, not `text-[Npx]` or Tailwind palette-class usage). **Flagged for human decision**: whether Tailwind palette-class usage (`bg-red-500` etc.) is in scope for Phase 2 token extraction, since DESIGN.md principle 2 says "no hex, no raw px" but doesn't explicitly call out named Tailwind color classes, and mechanically tokenizing 3,115 sites is a materially bigger job than the rest of this audit combined.

---

## 1. Color literals

### 1.1 Hex colors — exact/near matches against `index.css` tokens

`index.css` status/brand hex values (all defined in `:root`, mode-independent — see DESIGN.md brand tier):

```
--status-agent-idle: #a8aeb2      --status-task-backlog: #a8aeb2   --status-task-cancelled: #a8aeb2
--status-agent-running: #2563eb   --status-task-in_progress: #2563eb
--status-agent-paused: #f59e0b    --status-task-todo: #f59e0b
--status-agent-error: #dc2626     --status-task-blocked: #dc2626
--status-task-in_review: #7c3aed
--status-task-done: #22c55e
--status-task-icon-backlog: #52585d   --status-task-icon-todo: #cc7a00   --status-task-icon-done: #16a34a
--status-task-icon-cancelled: #52585d
(.dark overrides) --status-task-icon-backlog: #9a958a  -todo: #fbbf24  -in_review: #9474f0  -done: #34d06f  -cancelled: #9a958a
--paperclip-doc-annotation-highlight-*: #fef08a / #fde047 / #fef9c3 (light), #a16207 / #ca8a04 / #854d0e / #713f12 (dark)
--agent-1a..10b: 20 fixed brand hex (gradient stops), unique, not reused elsewhere in ui/src
```

**Exact matches found (case-insensitive value match) in `ui/src/lib/status-colors.ts`:**

| Hardcoded value | Site | Token it matches | Safe to swap without visual change? |
|---|---|---|---|
| `#A8AEB2` | `status-colors.ts:112,120,144` | `--status-agent-idle` / `--status-task-backlog` (`#a8aeb2`) | Yes — value identical, case differs only |
| `#2563EB` | `status-colors.ts:113,121,145` | `--status-agent-running` / `--status-task-in_progress` (`#2563eb`) | Yes |
| `#F59E0B` | `status-colors.ts:114,122,146` | `--status-agent-paused` / `--status-task-todo` (`#f59e0b`) | Yes |
| `#DC2626` | `status-colors.ts:115,123,149` | `--status-agent-error` / `--status-task-blocked` (`#dc2626`) | Yes |
| `#22C55E` | `status-colors.ts:147` | `--status-task-done` (`#22c55e`) | Yes |
| `#7C3AED` | `status-colors.ts:148` | `--status-task-in_review` (`#7c3aed`) | Yes |
| `#52585D` | `status-colors.ts:112,144` | `--status-task-icon-backlog` (light) (`#52585d`) | **Needs human decision** — token is mode-dependent (dark override `#9a958a`); this hardcoded value is used as a **fixed** chip background/text/border tint across both modes (it appears inside a class string with a separate literal `dark:` variant already, e.g. `dark:text-[#9A958A]`). The light value happens to equal the icon token; the surrounding hardcoded `dark:` variant (`#9A958A`) also happens to equal `--status-task-icon-backlog`'s dark override. So the *pair* is exactly reproducible via the token + its `.dark` override, but only if both the light and dark literals are replaced together — a partial swap would break one mode. |
| `#9A958A` | `status-colors.ts:112,144` | `--status-task-icon-backlog` `.dark` override (`#9a958a`) | Same caveat as above — pair with `#52585D` |

These 6 pairs (12 literal sites) in `status-colors.ts` are the largest concentration of **exact, likely-safe** matches found in this audit — consistent with PRIOR-ART's finding that exact matches are rare and cluster narrowly. All other hardcoded hex in the file (`#F5F3F0`, `#DBEAFE`, `#1D4ED8`, `#FEF3C7`, `#B45309`, `#FEE2E2`, `#991B1B`, `#DCFCE7`, `#188A3C`, `#EDE9FE`, `#5B21B6`, `#6E6960`/`#6e696024` alpha variants, and all the `dark:bg-[#...NN]` alpha-suffixed variants) have **no exact-value token match** — they are chip background tints (e.g., `#F5F3F0` light chip fill) that were hand-tuned independently of the base hue tokens and don't derive from them via any documented formula.

**`agentStatusBadge` (status-colors.ts:111-116) and `brandChipBadge` (status-colors.ts:143-149) are byte-for-byte identical maps** (same 4 shared keys: gray/blue/amber/red, same hex, same dark alpha suffixes) — flagged as a literal duplicate object, not just a duplicate value. `brandChipBadge` additionally has a `green` and `violet` entry `agentStatusBadge` lacks. **Needs human decision**: collapse `agentStatusBadge` into `brandChipBadge` (drop the redundant map) — this is a code dedup, not a token question, but it directly affects how many sites Phase 2 needs to touch.

### 1.2 Hex colors — no match, chart/status color arrays (mint new tokens)

Six files define standalone hex color arrays/maps for chart or dot rendering, none derived from `index.css`:

- `components/ActivityCharts.tsx:125-184` — priority colors (`critical #ef4444`, `high #f97316`, `medium #eab308`, `low #6b7280`) and a **second, differently-valued** status-color map (`todo #3b82f6`, `in_progress #8b5cf6`, `in_review #a855f7`, `done #10b981`, `blocked #ef4444`, `cancelled #6b7280`, `backlog #64748b`) that does **not** match `lib/status-colors.ts`'s `issueStatusColor`/`taskStatusVar` naming-to-hue mapping at all (e.g., `in_progress` is violet-ish `#8b5cf6` here vs. blue `#2563eb` in the canonical status system). **Flag: internal inconsistency**, not just missing tokens — this chart appears to use an entirely independent palette from the rest of the app's status system.
- `pages/OrgChart.tsx:162-169` — agent status dot colors (`running #22d3ee`, `active #4ade80`, `paused #facc15`, `idle #facc15`, `error #f87171`, `terminated #a3a3a3`) — again independent from `--status-agent-*` (compare `running`: `#22d3ee` here vs `#2563eb` token).
- `lib/timeline/layout.ts:131-136,162` — `TIMELINE_COLORS` (`delegated #5b9bf6`, `automation #f4b740`, `cancelled #9aa3ad`, `now #2dd4bf`) plus a runtime `hsl(hue 62% 52%)` per-issue hash color (line 162) — deliberately unbounded (hash-based), cannot be tokenized as discrete values; the 4 named constants can be.
- `pages/CompanySkills.tsx:549-551` — a 12-color palette array for skill/tag chips (`#6366f1, #0ea5e9, #10b981, #f59e0b, #ef4444, #8b5cf6, #ec4899, #14b8a6, #f97316, #22c55e, #3b82f6, #a855f7`).
- `lib/color-contrast.ts:9,71-72` — `DARK_BG {24,24,27}` (documented as zinc-900/`#18181b`), `TEXT_LIGHT #f8fafc`, `TEXT_DARK #111827` — contrast-calculation reference colors, functionally load-bearing (not decorative), needs care in Phase 2.
- `context/ThemeContext.tsx:20-21` — `DARK_THEME_COLOR #18181b`, `LIGHT_THEME_COLOR #ffffff` — sets the `<meta name="theme-color">` tag; same value family as `color-contrast.ts`'s `DARK_BG`.
- `lib/worktree-branding.ts:28,49` — fallback black/white pair (`#000000` / `#f8fafc` / `#111827`), same contrast-pair pattern as above.

**Cluster: 3 separate near-identical "readable text on dark/light" pairs** exist (`color-contrast.ts`, `worktree-branding.ts`, and implicitly `ThemeContext.tsx`'s theme-color), using `#f8fafc`/`#111827` twice and `#18181b`/`#020617`-family dark backgrounds inconsistently. **Flagged for human review** — looks like copy-paste convergence on the same Tailwind `slate-50`/`gray-900`-ish pair from three independent implementations; do not merge without checking each call site's actual contrast requirement.

### 1.3 Hex colors — project-color fallback cluster (widely repeated)

`#6366f1` (indigo) and `#64748b` (slate) are used as **default/fallback colors for user-configurable project colors** (`project.color ?? "#6366f1"` pattern) in 14 total sites:

- `#6366f1`: `pages/ProjectDetail.tsx:789`, `pages/CompanySettings.tsx:272`, `pages/CompanySkills.tsx:549`, `pages/PipelineSettings.tsx:2959,2974`, `plugins/bridge-init.ts:502,515`, `components/issue-properties/IssueProperties.tsx:181,1576,1649`, `components/NewIssueDialog.tsx:1489,1504` (+2 in test files)
- `#64748b`: `pages/Routines.tsx:751,766`, `components/MarkdownEditor.tsx:1355`, `components/RoutineRunVariablesDialog.tsx:426,441`, `components/RoutineList.tsx:121`, `components/IssueColumns.tsx:362`, `components/routine-sections/editable-sections.tsx:193,208`, `components/ActivityCharts.tsx:184` (also appears as the `backlog` chart color, see 1.2)

Neither matches an `index.css` token. **This is the single highest-value token-minting candidate in the whole audit** — one new `--project-color-fallback` (or two, if indigo/slate serve different call sites deliberately — `#6366f1` seems to be the "new project" default color picker seed, `#64748b` the "no project assigned" muted-slate fallback) would collapse 14+ sites. **Flag for human decision**: are these two meant to be the same fallback (a copy-paste drift) or intentionally different (new-project-color-picker-seed vs. no-project-slate)? The file-level pattern suggests two distinct call-site families (issue/project-creation UI uses indigo; routine/schedule UI uses slate), which argues for two tokens, not one.

### 1.4 Hex colors — miscellaneous singletons

- `components/ActivityFeed.tsx:286-288` and `components/FeedCard.tsx:432` — `#959596` (muted feed actor/verb text), 4 sites, 2 files. No token match. **This matches PRIOR-ART's called-out "muted feed text" gap cluster** — confirms it's still present and still untokenized.
- `components/OnboardingWizard.tsx:1722` — `bg-[#1d1d1d]` (dark decorative panel), singleton.
- `components/IssueChatThread.tsx:1451` — `bg-[#2563EB]` for "human's own message" bubble — **exact match** to `--status-agent-running`/`--status-task-in_progress` (`#2563eb`), but comment at line 1450 calls it "Liveness blue" independently — likely coincidental reuse of the same brand blue rather than a deliberate token reference. Flag as exact-match candidate but note the semantic mismatch (chat-bubble liveness vs. task-status liveness are different concepts that happen to share a hue).
- `pages/InviteUxLab.tsx:199,411` — `brandColor="#114488"` (lab/showcase-only, hardcoded prop value for a demo).
- `pages/CompanyEnvironments.tsx:427-431` — xterm.js terminal theme colors (`#0a0a0a`, `#f5f5f5`, `#22d3ee`, `#020617`, `#2563eb55`) — third-party terminal library config, arguably belongs on the documented allowlist (terminal chrome is intentionally distinct from app chrome).
- `fixtures/issueChatUxFixtures.ts:91` — `#0f766e` fixture data, out of runtime scope (test/demo fixture, not rendered UI chrome) but technically under `ui/src/`.
- `lib/mention-chips.ts:193` — `stroke="#000"` inside an inline SVG string (icon mask), singleton, likely intentional pure-black regardless of theme (needs human check).

---

## 2. `rgb()/rgba()/hsl()/hsla()` literals (52 sites, non-test)

Overwhelmingly **decorative gradient hero backgrounds** using `rgba(...)` inside Tailwind arbitrary `bg-[linear-gradient(...)]` / `bg-[radial-gradient(...)]` values:

- **UxLab/showcase pages** (majority of sites): `pages/IssueChatUxLab.tsx` (7), `pages/SystemNoticeUxLab.tsx` (5), `pages/InviteUxLab.tsx` (7), `pages/RunTranscriptUxLab.tsx` (2), `pages/ProfileSettings.tsx` (2) — these ARE routed (`/ux-lab/*`, `/design-guide`), not build-excluded, so they are in scope per DESIGN.md, but they are explicitly demo/showcase surfaces rather than product screens.
- **Production surfaces with the same gradient pattern**: `pages/Dashboard.tsx:222` (red budget-alert gradient), `pages/Costs.tsx:842` (subtle white gradient card), `components/AccountingModelCard.tsx:31`, `components/SidebarAccountMenu.tsx:163`, `components/BudgetIncidentCard.tsx:46`. Each gradient is a **unique** rgba tuple (no two production sites share the same gradient stops) — this is bespoke decoration per surface, not a systematic pattern, and is a strong "Needs human decision" candidate: minting one token per gradient (5+ new tokens) preserves pixels but does not reduce the "one way to say alert-card decoration" debt DESIGN.md principle 1 wants; collapsing them changes pixels.
- **Functional (non-decorative) uses**: `lib/mention-chips.ts:169` — `rgba(r,g,b,0.22)` computed at runtime from a hash-derived color (cannot be a static token). `components/CompanyPatternIcon.tsx:128,131` — `rgb(...)` canvas fill computed from props (same — dynamic, not tokenizable as a single value). `lib/timeline/layout.ts:162` — `hsl(hue 62% 52%)` runtime hash color (same). `components/FileViewerSheet.tsx:370,379` — `var(--paperclip-code-highlight-bg, rgba(250,204,21,0.12))` — this one **already has a CSS-var fallback pattern**, i.e., it's half-migrated: the var doesn't exist in `index.css` yet, only the inline fallback does. **Recommend this becomes the actual token** (`--paperclip-code-highlight-bg` / `-border`) in Phase 2 since the call site already expects it.

**Needs human decision**: whether one-off decorative gradients (Dashboard, Costs, AccountingModelCard, SidebarAccountMenu, BudgetIncidentCard, and all UxLab pages) should each mint a bespoke token (verbatim per DESIGN.md guardrails) or be added to the documented allowlist as "intentional decorative opt-outs" — minting ~15 near-duplicate gradient tokens that will never be reused elsewhere seems to work against the spirit of "tokens are the only source of visual values" even though it satisfies the letter of it.

---

## 3. Tailwind arbitrary bracket values (spacing / size / radius / type / shadow)

### 3.1 Font-size — `text-[Npx]` (730 sites, 137 files) — THE dominant cluster

| Value | Site count | Representative files (abbreviated where >10) |
|---|---:|---|
| **11px** | 417 | 104 files use it at least once. Heaviest: `pages/Secrets.tsx` (28), `pages/CompanySkills.tsx` (24), `components/transcript/RunTranscriptView.tsx` (20), `components/IssueChatThread.tsx` (17), `pages/TeamCatalog.tsx` (15), `components/IssueRunLedger.tsx` (15), `pages/AgentDetail.tsx` (12), `components/ProjectProperties.tsx` (12), `components/OnboardingWizard.tsx` (12), `components/IssueRecoveryActionCard.tsx` (12), + 94 more files |
| **10px** | 236 | 77 files. Heaviest: `components/IssueChatThread.tsx` (17), `components/transcript/RunTranscriptView.tsx` (15), `pages/TeamCatalog.tsx` (14), `pages/IssueDetail.tsx` (11), `components/CommentThread.tsx` (9), + 72 more |
| **13px** | 26 | `pages/IssueChatUxLab.tsx`, `pages/TeamCatalog.tsx`, `pages/Pipelines.tsx`, `pages/CompanySkills.tsx`, `pages/SystemNoticeUxLab.tsx`, `components/SidebarStarredProjects.tsx`, `components/SidebarAgents.tsx`, `components/SidebarProjects.tsx`, `components/SidebarAccountMenu.tsx`, `components/IssueChatThread.tsx`, `components/ArtifactsPanel.tsx`, `components/timeline/WorkTimelineChart.tsx`, `components/SidebarNavItem.tsx`, `components/Sidebar.tsx` |
| **12px** | 25 | `pages/CompanySkills.tsx`, `pages/SystemNoticeUxLab.tsx`, `plugins/launchers.tsx`, `components/DocumentDiffModal.tsx`, `components/DevRestartBanner.tsx`, `components/IssueAssignedBacklogNotice.tsx`, `components/IssueBlockedNotice.tsx`, `components/JsonSchemaForm.tsx` |
| **9px** | 13 | `pages/Secrets.tsx`, `pages/CompanySkills.tsx`, `components/AgentConfigForm.tsx`, `components/NewAgentDialog.tsx`, `components/OnboardingWizard.tsx`, `components/ActivityCharts.tsx`, `components/IssueFiltersPopover.tsx` |
| **15px** | 9 | `pages/Pipelines.tsx`, `pages/PipelineSettings.tsx`, `pages/IssueDetail.tsx`, `components/IssueDocumentsSection.tsx`, `components/PipelineItemBodyDocument.tsx`, `components/routine-sections/editable-sections.tsx`, `components/IssueAttachmentsSection.tsx` |
| **14px** | 4 | `components/IssueDocumentsSection.tsx`, `components/SourceResolvedFoldCallout.tsx`, `components/SystemNotice.tsx`, `components/IssueRecoveryActionCard.tsx` |

**FLAGGED CLUSTER — near-duplicate micro type scale.** This is the single largest and most consequential drift cluster in the codebase. 9/10/11/12/13/14/15px are all used, frequently in the *same component* for what appears to be the same semantic role ("small metadata label" vs. Tailwind's own `text-xs` = 12px baseline, which would cover several of these already). Sidebars alone (`Sidebar.tsx`, `SidebarNavItem.tsx`, `SidebarAgents.tsx`, `SidebarProjects.tsx`, `SidebarStarredProjects.tsx`, `SidebarAccountMenu.tsx`) all independently use `text-[13px]`, suggesting one genuine shared intent ("sidebar row label size") implemented as six separate arbitrary values instead of one. **PRIOR-ART's drafted "9 named `.type-*` intent styles incl. `micro` 11px / `nano` 10px" (see PRIOR-ART.md) directly targets this cluster** — this audit confirms the cluster is still present at large scale (653 of the 730 sites are 10px or 11px alone) and is the strongest candidate for that scale decision. **Do not merge here** — verbatim-extract each occurrence's exact px value into its own token per DESIGN.md Phase 2 guardrails; the human scale-collapse step (README "after the run" step 2) is where 9/10/11/12/13/14/15 get resolved into a real scale.

### 3.2 Letter-spacing — `tracking-[N em]` (202 sites)

| Value | Count |
|---|---:|
| 0.18em | 67 |
| 0.14em | 40 |
| 0.16em | 38 |
| 0.2em | 16 |
| 0.12em | 12 |
| 0.22em | 10 |
| 0.08em | 10 |
| 0.24em | 6 |
| 0.1em | 3 |

**FLAGGED CLUSTER** — 9 distinct tracking values across ~40 files, all in the 0.08–0.24em band (uppercase eyebrow/label letter-spacing, judging by co-occurrence with `text-[10/11px] uppercase` in the same class strings observed during sampling). Likely another case of "one intent, many literal values" — needs human collapse decision, not this run's job.

### 3.3 Width/height/min/max — arbitrary bracket values

`w-[...]`: 124 sites. `h-[...]`: 166 sites. `min-w/max-w/min-h/max-h-[...]`: 194 sites. Combined ~484 sites across roughly 90 files. Values are overwhelmingly **not near-duplicates of each other** in the way font-size is — they're bespoke per-surface panel/dialog/sidebar dimensions (`320px`, `220px`, `12rem`, `calc(100dvh-2rem)`, `85vh`, `var(--radix-popover-trigger-width)`, `var(--new-issue-dialog-height)`). A few small clusters worth flagging:

- **`30px`** appears as both a `w-[30px]` (4 sites) and `h-[30px]` (7 sites) — likely a consistent "icon button" footprint; check if these should route through a `size-*` token instead of duplicated w/h pairs.
- **`88px`** appears in both `w-[88px]` (2) and `h-[88px]` (4) — possibly the same avatar/tile footprint.
- **`220px`** (`h-[220px]`, 9 sites) and **`120px`** (`h-[120px]`, 7 sites) recur across otherwise-unrelated components (dialog/panel min-heights) — candidate for a semantic "compact panel min-height" token but flagged, not merged.
- `env(safe-area-inset-*)` and `var(--radix-*-trigger-width/height)` sites (≈15 total) are **not candidates for tokenization** — they reference runtime platform/library values, not design decisions; recommend allowlisting them explicitly rather than trying to wrap them in a token.

Representative file hotspots: `pages/CompanySkills.tsx` (16 `h-[`, 3 `w-[`), `pages/Pipelines.tsx` (9 `h-[`, 8 `w-[`), `components/OnboardingWizard.tsx` (6 `h-[`), `pages/CompanyImport.tsx`/`CompanyExport.tsx` (5 each).

### 3.4 Padding/margin — arbitrary bracket values (14 sites, small)

Mostly platform-safe-area handling, not design values:
- `pages/IssueDetail.tsx`, `components/MobileBottomNav.tsx`, `components/Layout.tsx` (×2), `components/RoutineRunVariablesDialog.tsx` — all `env(safe-area-inset-*)` — **recommend allowlisting**, not tokenizing (platform-derived, not a design value).
- `components/ActivityFeed.tsx:p-[18px]`, `components/FeedCard.tsx:p-[18px]` — exact-duplicate 18px padding across 2 files, no token match — small clean mint candidate.
- `components/ui/tabs.tsx:p-[3px]` — **stock shadcn value** (verified against current shadcn/ui registry — not local drift).
- `components/IssueChatThread.tsx:p-[15px]`, `components/IssueChatThread.test.tsx:p-[15px]` — matched pair.
- `components/IssueRow.tsx` — two `calc(theme(spacing.N)-2px)` expressions — these reference Tailwind's own spacing scale via `theme()`, arguably already "tokenized" in the loosest sense (derived from the Tailwind default scale, not a raw literal), but the `-2px` offset itself is a raw magic number. Flag for human review of intent.

### 3.5 Radius — arbitrary bracket values (25 sites)

| Value | Sites |
|---|---|
| `rounded-[28px]`, `rounded-[32px]`, `rounded-[24px]` | `pages/IssueChatUxLab.tsx`, `pages/ProfileSettings.tsx`, `pages/SystemNoticeUxLab.tsx`, `pages/InviteUxLab.tsx` (×6), `pages/CompanySettings.tsx` (`14px`) — all showcase/demo hero-card radii, no two pages agree on 24 vs 28 vs 32 |
| `rounded-[8px]` | `components/artifacts/ArtifactCard.tsx` (+test), `components/artifacts/ArtifactGroupCard.tsx` (×3) — internally consistent within the artifacts family |
| `rounded-[4px]` | `components/StatusBadge.tsx`, `components/ui/checkbox.tsx` (**stock shadcn value**, verified against registry) |
| `rounded-br-[4px]` / `rounded-bl-[4px]` | `components/IssueChatThread.tsx` — chat-bubble corner-clip, intentional asymmetric radius (speech-tail effect) |
| `rounded-[2px]` | `components/ui/tooltip.tsx` (**stock shadcn value** — tooltip arrow) |
| `rounded-[inherit]` | `components/ui/scroll-area.tsx` (not a literal value — keyword, skip) |

**Conflict with DESIGN.md — see section 6.** `--radius-lg` and `--radius-xl` are hard-set to `0px` in `index.css`'s `@theme inline` block, meaning every plain `rounded-lg` (188 uses) and `rounded-xl` (97 uses) class in the whole app currently renders **square, not rounded** — this is a live, current-state fact about the token layer itself, not a component-level drift issue, but it means the ~285 sites using `rounded-lg`/`rounded-xl` are silently at 0px and any future "fix" to those tokens will be a highly visible, non-zero visual change across most of the app.

### 3.6 Shadow — arbitrary bracket values (38 sites, 21 files)

Every value is a unique multi-stop `box-shadow` (drop shadows for hero cards, mostly `rgba(15,23,42,0.0X)` "cool black" tints at varying blur/spread). No two files share an identical shadow string except:
- `shadow-[0_24px_60px_rgba(15,23,42,0.08)]` (5 sites) and `shadow-[0_30px_80px_rgba(15,23,42,0.10)]` (3 sites) — both cluster around UxLab hero cards.
- `shadow-[0_-12px_28px_rgba(15,23,42,0.08)]` (3) and `shadow-[0_-12px_28px_rgba(0,0,0,0.28)]` (3) — same geometry, different color-mode tint (likely a light/dark pair that should have been expressed as one token with mode-aware color, not two separate arbitrary strings).
- `shadow-[0_1px_0_rgba(15,23,42,0.02)]` (3), `shadow-[0_0_0_2px_hsl(var(--background))]` (3) — the latter is interesting: it already references a CSS var (`--background`) inside an arbitrary value rather than a literal, i.e. partially tokenized.

Concentrated in: `pages/IssueChatUxLab.tsx`, `pages/RunTranscriptUxLab.tsx`, `pages/ProfileSettings.tsx`, `pages/InviteUxLab.tsx`, `pages/SystemNoticeUxLab.tsx`, `pages/AgentDetail.tsx`, `components/IssueThreadInteractionCard.tsx`, `components/ChatComposer.tsx`, `components/SourceResolvedFoldCallout.tsx`, `components/KeyboardShortcutsCheatsheet.tsx`, `components/LiveRunWidget.tsx`, `components/BudgetPolicyCard.tsx`, `components/BudgetSidebarMarker.tsx`, `components/SidebarNavItem.tsx`, `components/IssueRecoveryActionCard.tsx`, `components/environment-variables-editor/index.tsx`, `components/IssueChatThread.tsx`, `components/DocumentAnnotationLayer.tsx`, `components/CompanyPatternIcon.tsx`, `components/ActiveAgentsPanel.tsx`, `components/SystemNotice.tsx`.

**Needs human decision** — no existing shadow tokens exist in `index.css` at all (zero `--shadow-*` custom properties defined); every one of these 38 arbitrary shadows needs a brand-new token, and given how few are exact duplicates, this is close to "38 tokens for 38 sites" unless a human collapses them by visual similarity first.

### 3.7 Other bracket categories (small)

- `top/left/right/bottom-[...]` (14 sites): mostly `env(safe-area-inset-*)`, `50%`/`-50%` dialog-centering (shared with the stock shadcn `dialog.tsx`/`alert-dialog.tsx` pattern — **not local drift**), and one `top-[1px]` (`components/EntityRow.tsx:53`) hairline-alignment nudge.
- `z-[...]` (10 sites): `z-[1]`, `z-[2]`, `z-[9999]`, `z-[60]`, `z-[120]`, `z-[200]` — an ad hoc z-index scale with no documented tiers. **Flag**: no `--z-*` tokens exist; recommend a human-reviewed z-index scale decision, not in scope for this run's verbatim extraction beyond listing.
- `scale-[0.98]` (4 sites, all `pages/Inbox.tsx`) — consistent value, single file, easy mint.
- `blur-[2px]` (`components/IssueChatThread.tsx:3868`), `blur-[1px]` (`components/ChatComposer.tsx:253`) — 2 sites, 2 distinct values.
- `stroke-[2.3]` (`components/MobileBottomNav.tsx:109`) — SVG stroke-width, singleton.

---

## 4. Inline `style={{ }}` literals (58 files contain `style={{`)

Not every inline `style` is a hardcoded value — many pass through dynamic props (`style={{ width: size }}`). Filtering to literal-value cases:

- **Project-color fallback pattern** (`backgroundColor: x.color ?? "#6366f1"` / `"#64748b"`) — see section 1.3, 14 sites, already counted there.
- `components/AsciiArtAnimation.tsx:344` — `style={{ fontSize: "11px", fontFamily: "monospace" }}` — duplicates the 11px cluster (3.1) via inline style instead of Tailwind class; same value, different mechanism — worth noting Phase 2's codemod needs to handle both `text-[11px]` AND `fontSize: "11px"` forms.
- `components/MarkdownBody.tsx:193,197` — `borderRadius: "calc(var(--radius) - 4px)"`, `fontSize: "0.7rem"` — the radius line already routes through the `--radius` token (good pattern, not drift); the `fontSize: "0.7rem"` (=11.2px) is a **new near-duplicate of the 11px cluster** in yet another unit (rem vs. px) — flag for the human scale decision.
- `pages/CompanyEnvironments.tsx:422` — `fontSize: 12` (numeric, xterm.js option, third-party config — recommend allowlist).
- `pages/CompanySkills.tsx:579` — `fontSize: Math.round(size * 0.42)` — computed at runtime from a prop, not tokenizable as a static value.
- `components/WorktreeBanner.tsx:25` — `boxShadow: \`inset 0 -1px 0 ${branding.textColor}18\`` — dynamically computed from user branding color, not tokenizable.

---

## 5. Font-weight

No raw numeric `font-weight:` or `fontWeight:` declarations were found in component/page source outside `index.css` itself (which has 6 legitimate `font-weight: 500/600/700` declarations inside `.paperclip-markdown`/`.paperclip-markdown-codeblock-action` rules — these are the token layer, not drift). All font-weight in components goes through Tailwind's built-in `font-medium`/`font-semibold`/`font-bold` classes, which is compliant with DESIGN.md (weight isn't a token gap here). **No action needed for font-weight.**

---

## 6. Conflicts with DESIGN.md

1. **`--radius-lg` / `--radius-xl` are pinned to `0px`, and the base `--radius` is `0`, in the current `index.css`.** DESIGN.md principle 3 says "the final scale is a design decision made by a human after reviewing the token audit," implying the scale is still open — but the *current* values already silently zero out two full tiers of the radius scale sitewide (188 `rounded-lg` + 97 `rounded-xl` sites render square today). This isn't a conflict in the sense of a bug, but it does mean: (a) any component using `rounded-lg`/`xl` believing it gets a rounded corner is visually wrong today, and (b) `rounded-2xl`/`rounded-3xl` are NOT overridden (still Tailwind's stock 1rem/1.5rem), so the scale is non-monotonic as configured (`sm`=6px, `md`=8px, `lg`=0px, `xl`=0px, `2xl`=16px stock, `3xl`=24px stock) — a real inconsistency in the token file itself, not just in components. **Recorded here per DESIGN.md instruction to log conflicts rather than guess a fix.**
2. **`agentStatusBadge` and `brandChipBadge` in `lib/status-colors.ts` are literal duplicate objects** (see 1.1) — this isn't a DESIGN.md violation per se (DESIGN.md doesn't forbid duplicate non-visual code), but it directly undercuts principle 1 ("one way to say each thing") and inflates the token-migration site count; flagged here since Phase 2's codemods will otherwise "fix" the same value twice under two different export names.
3. **No `--shadow-*` tokens exist at all** in `index.css`, despite 38 arbitrary shadow values in components (3.6). DESIGN.md principle 2 lists "shadow" explicitly as a category that must route through tokens — today there is no token family for it to route through. Not a contradiction of DESIGN.md so much as a gap DESIGN.md anticipates Phase 2 will need to fill from scratch (mint, don't normalize).
4. **Tailwind palette utility classes** (`bg-red-500`, `text-amber-600`, etc., 3,115 sites) are a form of hardcoded value DESIGN.md's principle 2 language ("no hex, no raw px") doesn't unambiguously cover — these aren't hex literals or raw px, they're named utility classes backed by Tailwind's *own* built-in oklch palette, entirely separate from `index.css`'s token values. Whether this counts as "in scope" for the zero-hardcoded-value gate is genuinely ambiguous from the text of DESIGN.md and is the single biggest scope question for Phase 2. **See "Needs human decision" below.**

No other conflicts found — the rest of the codebase's approach (semantic tier for chrome, brand tier for agent/status colors, domain tier for chips/annotations) is followed consistently by the parts of the app that DO use tokens (e.g., `.status-chip`/`.status-fill` color-mix helpers, `.paperclip-mdxeditor` CSS-var bridge).

---

## 7. Off-limits / out-of-scope areas

- No `ui/src/components/theme-editor/` directory exists on this branch (confirmed via `find`) — KNOWN-DUPLICATES.md's off-limits note is currently moot here but preserved for when/if that code lands.
- No playground/experimental-theme paths found under `ui/src/` on this branch.
- Everything outside `ui/` (server, adapters framework config, CLI) is out of scope and was not scanned.
- `ui/storybook/` was inventoried only for the Phase-0 baseline-scope question (existing stories), not scanned for hardcoded values — it is fixture/test infrastructure, not shipped product UI.

---

## 8. Needs human decision (required section)

1. **Tailwind palette-class scope question** — are `bg-red-500`-style classes (3,115 sites / 145 files) in scope for Phase 2 token extraction? This is the largest single decision blocking Phase 2's actual size estimate. Recommend a separate, explicit ruling before Phase 2 starts, since it 10x's the mechanical work if in-scope.
2. **Micro type-size cluster (9/10/11/12/13/14/15px, 730+ sites)** — do not merge; this audit only inventories. PRIOR-ART's drafted 9-style `.type-*` system (incl. `micro`/`nano`) is the leading candidate for the eventual collapse decision. Needs a human to pick the real scale.
3. **Letter-spacing cluster (0.08–0.24em, 9 distinct values, 202 sites)** — same treatment as #2; no scale currently exists to collapse into.
4. **Radius token conflict (`--radius-lg`/`-xl` = 0px while `2xl`/`3xl` are untouched Tailwind stock)** — is the 0px lg/xl a deliberate brand choice (square corners) that should be preserved as-is, or a regression that should be fixed as part of the eventual radius-scale decision? PRIOR-ART's drafted scale (`sm 6 / md 8 / lg 10 / xl 14 / 2xl 16 / full`) assumes non-zero lg/xl — reconciling that draft with the current 0px reality is a human call.
5. **Project-color fallback duplication** (`#6366f1` indigo vs `#64748b` slate, 14 sites, section 1.3) — one token or two? File-level pattern suggests two distinct intents (new-project seed color vs. no-project-assigned muted slate) but this needs confirmation from whoever owns that UI, not an inference from this audit.
6. **`agentStatusBadge` vs `brandChipBadge` literal duplicate maps** (`lib/status-colors.ts`) — collapse to one export? This is a code-dedup call, adjacent to but not strictly a token-value question; flagged here because it changes Phase 2's site count.
7. **One-off decorative gradients/shadows on production surfaces** (Dashboard, Costs, AccountingModelCard, SidebarAccountMenu, BudgetIncidentCard — section 2; all of section 3.6) — mint ~20 bespoke, never-reused tokens (satisfies the letter of "tokens are the only source of visual values") or add a documented allowlist entry for "intentional one-off decoration" (satisfies the spirit of not inflating the token file with singletons)? DESIGN.md permits allowlisting "third-party overrides" but these are first-party decorative choices, so the allowlist criteria need a human ruling on whether it stretches to cover them.
8. **Chart color palettes disagree with the canonical status system** — `ActivityCharts.tsx`'s per-status hex map does not match `lib/status-colors.ts`'s hue mapping (e.g. `in_progress` renders violet-ish in the chart, blue in chips/icons elsewhere). Is this an intentional "charts get their own palette" design decision, or drift that should eventually re-point at `--status-task-*`? Flagging only — not resolving, per DESIGN.md's out-of-scope "no visual redesign" rule.
9. **Contrast-pair triplication** (`color-contrast.ts`, `worktree-branding.ts`, `ThemeContext.tsx` all define their own light/dark text or theme-color hex pairs, section 1.2) — candidates for one shared constant, but each has slightly different call-site semantics (WCAG contrast math vs. `<meta theme-color>` vs. branding fallback); needs a human to confirm they're actually meant to be identical before consolidating.
10. **Test-file hardcoded values (56 hex sites, plus proportional shares of the other categories)** — Phase 2's codemods will need a policy on whether test files get rewritten in lockstep with the components they assert against, or left alone (asserting against literal values that no longer appear verbatim in source once tokenized). Not addressed here since DESIGN.md's Phase 2 spec is silent on test files.

---

## Phase 2 extraction log — Batch 1 (colors)

Codemod: `scripts/codemod-extract-colors.mjs` (table-driven, idempotent — see script header for rationale on why a blind hex-regex sweep was rejected: it false-positives on strings like `acme/web#241` and `React #10140`). Scope: `ui/src/components/**` and `ui/src/pages/**`, including `*.test.tsx` companions, color literals only (hex / rgb / rgba / hsl / hsla / oklch). Shadow-embedded colors (`shadow-[...rgba(...)...]`) were explicitly left untouched per the batch mandate (Batch 3's job).

**Sites rewritten:** 69, across 31 files (30 component/page files + 1 test file, `IssueChatThread.test.tsx`, whose assertion string was updated in lockstep with the component it tests).

**Tokens minted: 41 new + 2 existing reused.**
- New verbatim tokens: 17 `--hex-*` (independent-palette status dots/priority/chart colors + the two project-color-fallback families) + 24 `--gradient-extract-*` (one per distinct gradient string; all 24 are pixel-verbatim, none normalized — two pairs of sites shared an identical gradient string and reused the same token: `--gradient-extract-9` used at IssueChatUxLab.tsx:139 + InviteUxLab.tsx:700; `--gradient-extract-10` at IssueChatUxLab.tsx:203 + InviteUxLab.tsx:909).
- Reused existing tokens (exact case-insensitive match, mode-independent — no `.dark` override in index.css for either): `#2563EB` → `var(--status-task-in_progress)` (IssueChatThread.tsx "Liveness blue" bubble); `#22c55e` → `var(--status-task-done)` (was not actually hit by a component site in this batch's table — flagged as available for Batch 2+ if a matching site turns up; the number above counts sites where a REUSE mapping fired, which was only the `#2563EB` family, at 2 sites: component + test assertion).
- All new tokens and the allowlist doc-comment live in a single non-`@theme` `:root { ... }` block appended to `ui/src/index.css`, headed `/* ── Extracted verbatim tokens (Phase 2, design/token-extraction) ── */`, per DESIGN.md (runtime-tunable, not baked into `@theme inline`).

**Sites allowlisted (8 files, inline `token-extraction: allowlisted` comment at each site) — functional/third-party, converting would change behavior, not just pixels:**
1. `pages/CompanyEnvironments.tsx` — xterm.js terminal theme option object (`background`/`foreground`/`cursor`/`cursorAccent`/`selectionBackground`); third-party config consumed by the terminal library, not rendered CSS.
2. `pages/CompanySettings.tsx` — `<input type="color">` value; the DOM color-picker control requires a real hex string.
3. `components/issue-properties/IssueProperties.tsx` — `newLabelColor` picker-seed state, persisted into the label-create payload sent to the backend.
4. `pages/CompanySkills.tsx` — `DISCOVERY_ACCENTS` palette array; `skillAccentColor()`'s return value is written into `SkillCreateDraft.color` (persisted/compared data), not just used as a rendered value.
5. `components/IssueColumns.tsx` — `accentColor` fallback also feeds `pickTextColorForPillBg()` contrast math (from `lib/color-contrast.ts`), which needs a real hex string to compute luminance.
6. `components/CompanyPatternIcon.tsx` — canvas 2D `fillStyle` built from a runtime-computed template literal (`rgb(${r} ${g} ${b})`), not a static literal at all (excluded from the site table for this reason, not just allowlisted).
7. `components/FileViewerSheet.tsx` — `bg-[var(--paperclip-code-highlight-bg,rgba(250,204,21,0.12))]` / `border-[var(--paperclip-code-highlight-border,rgb(234,179,8))]` — a half-migrated `var(--x, fallback)` pattern where `--paperclip-code-highlight-bg`/`-border` don't exist in `index.css` yet (see section 2 above). Left alone rather than guessed at, since minting the var changes the semantics of an existing fallback expression rather than being a 1:1 literal swap — flagged below as "Needs human decision."
8. `pages/InviteUxLab.tsx` — `brandColor="#114488"` (×2, demo/showcase page) feeds `CompanyPatternIcon`'s `hexToHue()` color math via the same canvas-fill code path as #6, not a rendered CSS value.

**Verify results:** `rg` gate clean (zero hex/rgb/hsl/oklch literals in Tailwind class strings or inline styles in `ui/src/components/**` / `ui/src/pages/**` outside the 8 allowlisted files); `pnpm build-storybook` exit 0; Storybook visual snapshot suite **510/510 passed, 0 failed** (`npx playwright test --config tests/storybook-visual/playwright.config.ts`); `pnpm typecheck` exit 0.

**Bug caught and fixed during verification (documented for future batches):** the first codemod pass minted gradient tokens by copying Tailwind's bracket-arbitrary-value syntax verbatim, including underscore-for-space escaping (e.g. `radial-gradient(circle_at_top,...)`). That escaping is Tailwind's own class-name convention — real CSS custom properties are not parsed the way Tailwind parses bracket values, so `circle_at_top` inside a `--gradient-extract-N` declaration is invalid `radial-gradient()` syntax and the browser drops the whole background-image. Caught by the Playwright visual suite (`ux-labs-converted-test-pages--invite-and-access-flow [light]` failed, 6% pixel diff, dark hero panel rendered as plain gray). Fixed by converting all underscores back to literal spaces in the 24 gradient token values before re-running. This is now a standing gotcha for Batches 2-4: any bracket-value string being lifted into a CSS custom property must have Tailwind's `_`→` ` escaping reversed first.

**Needs human decision (new, from this batch):**
- `components/FileViewerSheet.tsx`'s `--paperclip-code-highlight-bg`/`-border` half-migrated var-with-fallback pattern (allowlist item 7 above) — TOKEN-AUDIT.md section 2 already recommended "this becomes the actual token"; this batch deliberately did NOT act on that recommendation because defining the var changes what `var(--x, fallback)` resolves to structurally (from "always the literal fallback" to "the var if defined, else the fallback") even though the *value* would be identical today — a human should confirm this is the intended direction before Batch 2+ touches it, alongside the sibling `--paperclip-code-bg`/`--paperclip-code-gutter-fg` vars in the same file that use `theme(colors.muted...)` fallbacks (out of scope for colors, relevant to a future spacing/type batch).
- The `#2563EB` reuse (`IssueChatThread.tsx`'s "Liveness blue" chat bubble → `--status-task-in_progress`) is a **semantic coincidence**, not a designed relationship — the original code comment explicitly called it "Liveness blue" independently of the task-status system. Batch 1 reused the token per the exact-match rule, but a human should confirm a chat-bubble liveness color is supposed to be permanently coupled to the task `in_progress` status hue going forward (if a future redesign changes one, does the other move too?).

---

## Phase 2 extraction log — Batch 2 (type)

Codemod: `scripts/codemod-extract-type.mjs`. Unlike Batch 1's hand-audited site table (needed to avoid hex-like false positives such as issue references), this batch's patterns — `text-[Npx]`/`text-[N.Nrem]` Tailwind font-size, `tracking-[N em]` letter-spacing, `leading-[...]` line-height, and `fontSize: "Npx"`/`fontSize: "N.Nrem"` inline-style string literals — are unambiguous, so the codemod does a blanket regex sweep scoped to `ui/src/components/**` and `ui/src/pages/**` (including `*.test.tsx` companions; a full scan found **zero** test files containing any of these patterns, so no test file needed a lockstep update this batch). Verified idempotent (second run: 0 sites, 0 files changed).

**Sites rewritten: 932**, across 143 files.
- Font-size Tailwind class utilities (`text-[Npx]`): 728 sites (matches TOKEN-AUDIT.md section 3.1's count almost exactly — 730 vs. 728, negligible drift from audit-vs-extraction timing). No rem-unit or line-height-suffixed (`text-[N]/[N]`) forms were found in class strings; none existed to convert.
- Letter-spacing (`tracking-[N em]`): 202 sites, matching TOKEN-AUDIT.md section 3.2 exactly (9 distinct values).
- `leading-[...]` line-height brackets: 0 sites found (confirmed via full sweep; TOKEN-AUDIT.md did not call this out as a populated cluster either).
- Inline-style `fontSize` string literals: 2 sites — `components/AsciiArtAnimation.tsx:344` (`fontSize: "11px"`, reused the same `--fs-11` token minted by the class-based sites — no duplicate) and `components/MarkdownBody.tsx:197` (`fontSize: "0.7rem"`, new rem-unit token).

**Tokens minted: 17 new** (0 reused from Batch 1 — font-size/letter-spacing/line-height had no prior tokens to match against).
- 8 `--fs-*` (font-size): `--fs-9`, `--fs-10`, `--fs-11`, `--fs-12`, `--fs-13`, `--fs-14`, `--fs-15` (px, one per distinct value found) + `--fs-0_7rem` (0.7rem, `MarkdownBody.tsx`'s inline style — kept in rem per DESIGN.md "no normalizing/unit-converting" rule, NOT collapsed into the 11px-ish px cluster even though 0.7rem ≈ 11.2px).
- 9 `--ls-*` (letter-spacing): `--ls-0_08`, `--ls-0_1`, `--ls-0_12`, `--ls-0_14`, `--ls-0_16`, `--ls-0_18`, `--ls-0_2`, `--ls-0_22`, `--ls-0_24` — one per distinct em value, matching TOKEN-AUDIT.md 3.2's 9-value cluster exactly.
- 0 `--lh-*` (line-height) — no sites required one; the token-registration code path exists in the codemod (and was exercised in the Step 0 syntax spike) for forward-compatibility but minted nothing this batch.
- All new tokens live in a second non-`@theme` `:root { ... }` block appended to `ui/src/index.css` immediately after Batch 1's color block, headed `/* ── Extracted verbatim TYPE tokens (Phase 2 Batch 2, design/token-extraction) ── */`, per DESIGN.md (runtime-tunable). **No normalizing performed** — 9/10/11/12/13/14/15px and the 9 distinct tracking values all remain distinct tokens; the human scale-collapse decision (TOKEN-AUDIT.md "Needs human decision" #2/#3, PRIOR-ART's draft `.type-*` scale) is explicitly deferred, per mandate.

**Tailwind v4 rewrite forms used** (confirmed via mandatory Step-0 syntax spike — scratch story + `pnpm build-storybook` + grep of emitted CSS, then deleted before the real codemod ran):
- `text-[11px]` → `text-(length:--fs-11)` — emits `font-size:var(--fs-11)`. The `length:` hint is REQUIRED; a bare `text-(--fs-11)` would be interpreted as a color utility.
- `tracking-[0.18em]` → `tracking-(--ls-0_18)` — emits `--tw-tracking:var(--ls-0_18);letter-spacing:var(--ls-0_18)`. Unambiguous, no hint needed.
- `leading-[...]` (numeric/unit forms only) → `leading-(--lh-*)` — verified to emit `--tw-leading:var(--lh-*);line-height:var(--lh-*)` in the spike; not exercised on a real site since 0 sites existed.
- All variant/modifier prefixes preserved verbatim by construction (the regex only rewrites the bracket portion): confirmed sites include `sm:text-[11px]` (`components/BlockedReasonChip.tsx`), a compound arbitrary-variant `group-data-[size=xs]/avatar:text-[10px]` (`components/ui/avatar.tsx`), and an `!important`-marked bracket-selector `[&>span:last-child]:!text-[11px]` (`components/ActiveAgentsPanel.tsx`) — all rewrote correctly to `sm:text-(length:--fs-11)`, `group-data-[size=xs]/avatar:text-(length:--fs-10)`, and `[&>span:last-child]:!text-(length:--fs-11)` respectively.

**Sites allowlisted (2 sites, both already covered by Batch 1's allowlist doc-comment structure for their files, no new inline comments needed since neither is a bracket-literal or class-string site):**
1. `pages/CompanyEnvironments.tsx:422` — `fontSize: 12` inside the xterm.js terminal theme option object (same object Batch 1 allowlisted for its color literals). Numeric, functional third-party config — not a rendered CSS value, not a string literal the codemod's regex targets.
2. `pages/CompanySkills.tsx:580` — `fontSize: Math.round(size * 0.42)` — computed at runtime from a prop; not a static literal, nothing to extract.

**Verify results:**
- `rg` gates clean in `ui/src/components/**` / `ui/src/pages/**`: zero `text-[Npx]`/`text-[N.Nrem]` arbitrary font-size, zero `tracking-[N em]`, zero numeric `leading-[...]`, zero raw `fontSize: "..."` string literals remain (the only two `fontSize:` string-literal grep hits left are the already-converted `fontSize: "var(--fs-11)"` / `fontSize: "var(--fs-0_7rem)"` sites).
- `pnpm build-storybook` exit 0.
- Storybook visual snapshot suite: **510/510 passed, 0 failed**, first attempt, no retries needed (`npx playwright test --config tests/storybook-visual/playwright.config.ts --reporter=line`).
- `pnpm typecheck` exit 0.
- Codemod re-run confirmed idempotent: second invocation reports 0 sites rewritten, 0 files changed, token block already present.

**Needs human decision:** none new from this batch beyond the already-logged #2 (micro type-size cluster) and #3 (letter-spacing cluster) in section 8 above — this batch's 17 minted tokens are exactly the verbatim inventory those two items describe, now materialized as CSS custom properties ready for a human to collapse into a real scale.

---

## Phase 2 extraction log — Batch 3 (sizes/spacing/radius/shadows)

Codemod: `scripts/codemod-extract-sizes.mjs`. Blanket regex sweep (like Batch 2 — these bracket-utility families are unambiguous), scoped to `ui/src/components/**` and `ui/src/pages/**` including `*.test.tsx` companions. Covers `w-[...] h-[...] size-[...] min-w/max-w/min-h/max-h-[...]`, `p*/m*-[...]`, `gap-[...]`/`gap-x/y-[...]`, `inset/inset-x/inset-y/top/left/right/bottom-[...]`, `translate-x/y-[...]`, `rounded-[...]` (incl. directional `rounded-t/r/b/l/tl/tr/bl/br-[...]`), `shadow-[...]`, `ring-[...]`, `outline-[...]`. Verified idempotent (second run: 0 sites, 0 files changed).

**Sites rewritten: 407**, across 140 files (127 component/page files + 13 test files rewritten in lockstep: `ChatComposer.test.tsx`, `FileViewerSheet.test.tsx`, `IssueChatThread.test.tsx`, `IssueFiltersPopover.test.tsx`, `IssueSiblingNavigation.test.tsx`, `MarkdownBody.test.tsx`, `MarkdownEditor.test.tsx`, `NewIssueDialog.test.tsx`, `RoutineRunVariablesDialog.test.tsx`, `SidebarAccountMenu.test.tsx`, `artifacts/ArtifactCard.test.tsx`, `Agents.test.tsx`, `IssueDetail.test.tsx`).

**Tokens minted: 163 new** (127 `--sz-*` + 8 `--rad-*` + 5 `--pct-*` + 23 `--shadow-extract-*`; 0 reused from Batches 1-2 — no existing size/radius/shadow tokens existed to match against, and DESIGN.md/TOKEN-AUDIT.md section 6.3 already noted zero `--shadow-*` tokens existed pre-Phase-2).
- **`--sz-*` (127 tokens)** — ONE shared family across width/height/min/max, padding/margin, gap, inset/top/left/right/bottom, and translate, so identical literal values dedupe regardless of which property used them (e.g. a `220px` used as both `h-[220px]` and `w-[220px]` in different files collapses to one `--sz-220px`). Includes:
  - 85 simple numeric length tokens (`--sz-320px`, `--sz-18rem`, `--sz-85vh`, `--sz-24ch`, etc. — px/rem/em/vh/vw/dvh/dvw/ch units, verbatim, no rounding).
  - 42 `--sz-calc-N` tokens for `calc()`/`min()`/`max()`/`clamp()` compound expressions (sequentially numbered since content isn't safely nameable); 2 sites reused an existing `--sz-calc-N` where the exact string recurred (`min(calc(100dvh - 2rem),42rem)`-style forms did not recur verbatim, but `theme(spacing.N)` resolution below did feed distinct calcs — no cross-file duplicate calc strings were found this batch).
  - 2 `--sz-safe-*` tokens (`--sz-safe-top`, `--sz-safe-bottom`) for bare `env(safe-area-inset-*)` forms with no arithmetic — `Layout.tsx`, `MobileBottomNav.tsx`. `env()` forms MIXED into a `calc()`/`min()`/`max()` (e.g. `calc(5rem+env(safe-area-inset-bottom))`, `max(1rem,env(safe-area-inset-top))`) were folded into the `--sz-calc-N` family instead, verbatim (`env()` is valid inside a runtime custom property — confirmed in the Step 0 spike).
- **`--rad-*` (8 tokens)** — shared across radius, ring-width, and outline-width (`--rad-2` through `--rad-32`, bare-number naming to match Batch 1/2's `--fs-11`-style convention since every site here used px). Two directional-radius sites (`IssueChatThread.tsx`'s `rounded-br-[4px]`/`rounded-bl-[4px]` speech-tail corners) reuse the same `--rad-4` token minted from `StatusBadge.tsx`'s bare `rounded-[4px]`.
- **`--pct-*` (5 tokens)** — `--pct-50`, `--pct-72`, `--pct-85`, `--pct-90` (bare percentages) + `--pct-neg-50` (kept as a DISTINCT token from `--pct-50`, not a negated reference, because the source bracket already carries the minus sign inside the value itself — `translate-x-[-50%]`, not `-translate-x-[50%]` — confirmed via the Step 0 spike that both the `-utility-(--x)` prefix-negation form AND a literal negative-value token both compile correctly, and the codebase's actual sites are all the latter form).
- **`--shadow-extract-*` (23 tokens)** for 38 sites (dedup: `--shadow-extract-15` = `0 24px 60px rgba(15,23,42,0.08)` reused at 5 sites; `--shadow-extract-17` = `0 30px 80px rgba(15,23,42,0.10)` reused at 3 sites — matching the two clusters TOKEN-AUDIT.md section 3.6 flagged). Underscore-to-space reversal applied to every shadow value per Batch 1's gradient gotcha, generalized (`shadow-[0_0_0_2px_hsl(var(--background))]` → `0 0 0 2px hsl(var(--background))`). Two sites are `dark:` variant pairs sharing the same base shadow token family but pointing at different tokens (`ChatComposer.tsx`/`IssueChatThread.tsx`/`ChatComposer.test.tsx`: light `shadow-(--shadow-extract-4)`, `dark:shadow-(--shadow-extract-5)`).
- All new tokens live in a third non-`@theme` `:root { ... }` block appended to `ui/src/index.css` immediately after Batch 2's type block, headed `/* ── Extracted verbatim SIZE/SPACING/RADIUS/SHADOW tokens (Phase 2 Batch 3, design/token-extraction) ── */`, per DESIGN.md (runtime-tunable).

**var()-only passthrough (11 sites, 0 new tokens minted per DESIGN.md's special case)** — bracket values that only wrap a runtime library/component variable are rewritten straight to the bare paren form with no token mint: `w-[var(--radix-popover-trigger-width)]` → `w-(--radix-popover-trigger-width)` (`SearchableSelect.tsx` ×1, `OnboardingWizard.tsx` ×1, `AgentConfigForm.tsx` ×3), `h-[var(--radix-select-trigger-height)]` / `min-w-[var(--radix-select-trigger-width)]` → same form (`ui/select.tsx` ×2), `h-[var(--new-issue-dialog-height)]` / `max-h-[var(--new-issue-dialog-height)]` → same form (`NewIssueDialog.tsx` ×2, `NewIssueDialog.test.tsx` ×2 in lockstep).

**`theme(spacing.N)` resolution (`components/IssueRow.tsx`, 3 sites)** — `theme()` is a Tailwind build-time function and does not work inside a runtime CSS custom property. Resolved using Tailwind v4's default `--spacing: 0.25rem` base (confirmed no `--spacing` override exists in `index.css`, and the BUILT CSS for these exact classes was inspected before the codemod ran: `padding-left:calc(.5rem - 2px)` / `calc(.25rem - 2px)` for `theme(spacing.2)`/`theme(spacing.1)` respectively, and a plain `margin-left:1.25rem` for the fully-constant `theme(spacing.3)+theme(spacing.2)` expression). Minted as `--sz-calc-11: calc(0.5rem - 2px)`, `--sz-calc-12: calc(0.25rem - 2px)`, `--sz-calc-13: calc(0.75rem + 0.5rem)` — byte-equivalent computed output verified via headless-browser spike (`6px`/`4px`/`1.25rem` respectively, matching the pre-codemod built CSS exactly).

**Sites allowlisted / intentionally skipped (2 items):**
1. `components/ui/scroll-area.tsx` — `rounded-[inherit]` is a CSS **keyword**, not a literal value; the codemod explicitly detects and skips it (no rewrite, no token). Documented in the `index.css` block comment.
2. `components/CompanyPatternIcon.tsx` — `drop-shadow-[0_1px_2px_rgba(0,0,0,0.65)]` is a **different Tailwind utility** (`drop-shadow`, a CSS `filter` function) than the batch mandate's `shadow-[...]` (`box-shadow`) pattern; left untouched as out of the batch's explicit scope (TOKEN-AUDIT.md section 3.6 also only inventoried `shadow-[...]`, not `drop-shadow-[...]`) — flagged here for a future batch or human decision on whether `drop-shadow` should be folded into the same `--shadow-extract-*` family or get its own.

**BOUNDARY BUG caught and fixed during this batch (documented for future batches):** the first codemod pass used a bare `\b` word-boundary regex for `top/left/right/bottom-[...]`, which false-positived on Tailwind's own compound animation utilities `slide-out-to-top-[1%]` / `slide-in-from-top-[1%]` (`components/ui/dialog.tsx`, `components/ui/alert-dialog.tsx`) — `\b` matches at the `-to-top` boundary since `-` is not a word character, so the regex silently corrupted `slide-out-to-top-[1%]` into `slide-out-to-top-(--pct-1)`, which Tailwind does not recognize as the `slide-out-to-top-*` utility at all (a real, silent visual/behavioral regression, not just a naming nit — caught by manual inspection before the Playwright run, not by the snapshot suite itself, since the corrupted form simply drops the animation rather than changing a static rendered pixel in a way the frozen-time/reduced-motion snapshot harness would catch). Fixed by requiring the utility name to start at a genuine class-token boundary (preceded by whitespace, a quote/backtick, template-literal `${`, colon `:` for variant prefixes, or start-of-string) rather than a bare `\b`.

**CALC-SPACING BUG caught and fixed during this batch (second gotcha, generalizing Batch 1's underscore lesson):** two distinct spacing problems in calc() expressions, both caught via the Step 0 spike and a subsequent live headless-browser check:
1. `calc(100%-2rem)`-style brackets (NO space around the operator at all, not even underscore-escaped) are syntactically INVALID once lifted verbatim into a CSS custom property — a headless-browser test confirmed `calc(100%-2rem)` silently drops (computed value falls back to the containing block's own size) while `calc(100% - 2rem)` computes correctly. Fixed with a `normalizeCalcSpacing()` helper that inserts spacing around top-level `+`/`-` operators.
2. The first version of that helper was too broad (matched any letter-hyphen-letter sequence) and corrupted `env(safe-area-inset-bottom)` into `env(safe - area - inset - bottom)` inside `calc(1.5rem+5rem+env(safe-area-inset-bottom))` — caught via manual `grep`/inspection of the generated token block before the Playwright run (the malformed token would have made the whole value invalid, again a silent drop rather than a pixel diff the snapshot suite would flag directly, though it likely would have surfaced as a layout diff on `ScrollToBottom.tsx`'s stories). Fixed by narrowing the operator-spacing regex to only fire when the LEFT side is a number/number-with-unit/closing-paren and the RIGHT side is a number or the start of a known CSS value-function call (`env(`, `var(`, `calc(`, `min(`, `max(`, `clamp(`) — this excludes any hyphen sitting between two bare identifier characters.

**COMMENT-SYNTAX BUG caught and fixed during this batch (third gotcha, new category — a lesson for future codemods' generated CSS comments, not the token values themselves):** the codemod's own generated `index.css` doc-comment originally read "`--rad-* is likewise shared across rounded-*/ring/outline widths.`" — the literal two-character sequence `*/` inside "rounded-\*/ring" prematurely closed the enclosing CSS block comment, and everything from that point to the real intended `*/` several lines later was parsed as raw (garbled, non-declaration) CSS. This didn't just corrupt the comment — it desynced the CSS parser badly enough that the ENTIRE Batch 3 `:root { ... }` token block (all 163 tokens) was silently dropped from the compiled Storybook CSS, while the hundreds of `var(--sz-*)`/`var(--rad-*)` REFERENCES in component class names still compiled fine (Tailwind generates utility classes independent of whether the referenced custom property is actually declared anywhere) — so every `--sz-*`/`--rad-*`/`--pct-*`/`--shadow-extract-*` reference resolved to nothing (`unset`, i.e. `0` for lengths), which is what produced the initial 222-test Playwright failure (all length/radius/shadow values silently collapsing to their initial/zero value). Caught by: (a) the Playwright run failing far more broadly than a mechanical rename should cause, (b) isolating a single-file change that passed in isolation but failed in the full batch, (c) directly querying `getComputedStyle(...).marginTop` in a live headless-browser session against the built Storybook static output, which showed `0px` instead of the expected `7px`, and (d) a manual `/*`/`*/` balance count over the generated CSS block, which found the block was one `*/` short of balanced. Fixed by rephrasing the comment to avoid a bare `*/`-forming substring ("rounded, ring, and outline widths" instead of "rounded-\*/ring/outline widths") and adding an inline guard-comment in the codemod script itself warning future editors never to let generated CSS-comment prose contain a literal `*/` sequence.

**Verify results:**
- `rg` gates clean in `ui/src/components/**` / `ui/src/pages/**`: zero remaining `w-[...]/h-[...]/size-[...]/min-w-[...]/max-w-[...]/min-h-[...]/max-h-[...]`, zero `p*/m*-[...]`, zero `gap-[...]`/`gap-x/y-[...]`, zero `inset/inset-x/inset-y/top/left/right/bottom-[...]` (except Tailwind's own `slide-out-to-top-[1%]`/`slide-in-from-top-[1%]` compound utilities, which are NOT this batch's target pattern), zero `translate-x/y-[...]`, zero `rounded*-[...]` (except the documented `rounded-[inherit]` keyword skip), zero `shadow-[...]` (except the out-of-scope `drop-shadow-[...]` noted above), zero `ring-[...]`, zero `outline-[...]`.
- `pnpm build-storybook` exit 0.
- Storybook visual snapshot suite: **510/510 passed** on the final verification run (509 passed clean + 1 known-benign flaky retry — `product-documents-annotations--integrated-desktop-open [dark]`, the exact flake called out in the batch mandate as expected-benign — passed on Playwright's automatic retry, exit code 0). An earlier run with the COMMENT-SYNTAX BUG present failed 222/510 (all attributable to the single root cause above, not 222 independent regressions); after the fix, first clean re-run passed 510/510 with zero retries needed, and the final verification run (rebuilt from scratch a second time) reproduced the single known-benign flaky retry only.
- `pnpm typecheck` exit 0.
- Codemod re-run confirmed idempotent: second invocation reports 0 sites rewritten, 0 files changed, token block already present.

**Needs human decision (new, from this batch):**
- **`drop-shadow-[...]` vs `shadow-[...]` token family** (`components/CompanyPatternIcon.tsx`, 1 site) — should `drop-shadow` values share the `--shadow-extract-*` family this batch minted, or get their own `--drop-shadow-extract-*` family? Left untouched this batch since TOKEN-AUDIT.md section 3.6 only inventoried `box-shadow` (`shadow-[...]`) sites, and the mission mandate for this batch was explicitly `shadow-[...]` only.
- **`theme(spacing.N)` resolution direction** (`components/IssueRow.tsx`) — this batch resolved `calc(theme(spacing.N)±Mpx)` to its Tailwind-v4-default-scale rem equivalent (verbatim, byte-equivalent verified) rather than leaving it as a build-time-only expression. If a future change to Tailwind's `--spacing` base ever happens, these 3 tokens will silently stop tracking that base (since they're now baked rem literals, not `theme()` calls) — a human should confirm this is the intended tradeoff, or decide these 3 sites should instead reference the Tailwind spacing scale by a different mechanism.
- **`--pct-neg-50` vs prefix-negation form** — this batch mints distinct positive/negative percentage tokens (`--pct-50` / `--pct-neg-50`) rather than using Tailwind's `-utility-(--x)` prefix-negation shorthand, because every negative-percentage site in this codebase already carries the minus sign inside the bracket value itself (`translate-x-[-50%]`), not as a separate utility-level negation (`-translate-x-[50%]`). A human doing the eventual scale-collapse pass should be aware both forms exist in Tailwind v4 and this codebase consistently uses the former.

---

## Phase 2 extraction log — Batch 4 (final sweep + gates)

Codemod: `scripts/codemod-extract-misc.mjs`. Blanket regex sweep (same style as Batches 2-3 — these remaining bracket-utility families are unambiguous), scoped to `ui/src/components/**` and `ui/src/pages/**` including `*.test.tsx` companions. Covers `grid-cols-[...]`/`grid-rows-[...]`, `transition-[...]`, `z-[...]`, `scale-[...]`, `ease-[...]`, `align-[...]`, `stroke-[...]`, `blur-[...]`/`backdrop-blur-[...]`, `drop-shadow-[...]`, `bg|text|border-[var(--x)]` (with and without a `,fallback`), and — discovered during this batch's own bracket sweep, not in the original task list — 2 `bg-[linear-gradient(...)]` sites that Batch 1's hand-audited color-literal table did not catch (see "scope correction" below). Verified idempotent (second run: 0 sites, 0 files changed).

**MANDATORY STEP 0 SYNTAX SPIKE (scratch stories + `pnpm build-storybook` + grep of emitted CSS, deleted before the real codemod ran):** every paren form in the batch mandate was confirmed byte-equivalent before any component was touched:
- `grid-cols-(--gtc-N)` with a multi-part track list containing `minmax()` → `grid-template-columns:var(--gtc-N)`. Confirmed.
- `transition-(--tp-N)` → `transition-property:var(--tp-N)` (plus the timing-function/duration vars Tailwind always emits alongside). Confirmed it sets `transition-property`, not some other longhand.
- `z-(--z-N)` → `z-index:var(--z-N)`. Confirmed.
- `scale-(--s-N)` → `scale:var(--s-N)`. Confirmed.
- `ease-(--e-N)` → `transition-timing-function:var(--e-N)` (and `--tw-ease`). Confirmed.
- `align-(--va-N)` → `vertical-align:var(--va-N)`. Confirmed.
- `stroke-(length:--sw-N)` → `stroke-width:var(--sw-N)`. Confirmed the `length:` hint is REQUIRED — a bare `stroke-(--x)` would be ambiguous with the `stroke` COLOR utility, same reasoning as Batch 3's `ring`/`outline` hint requirement.
- `backdrop-blur-(--blur-N)` → `--tw-backdrop-blur:blur(var(--blur-N))`. Confirmed (spiked separately after discovering the batch's 2 real sites are `backdrop-blur-[...]`, not bare `blur-[...]` — see gotcha below).
- Fallback-comma paren form (`bg-(--x,fallback)`): **NOT SUPPORTED.** Tailwind v4's paren shorthand only accepts a single custom-property reference (optionally with a `type:` hint); a literal comma-separated fallback inside the parens does not parse as a fallback expression. Per the mission's fallback plan, a wrapper token (`--code-highlight-bg-resolved: var(--paperclip-code-highlight-bg, rgba(250, 204, 21, 0.12));`) was minted instead and referenced via the plain `bg-(--code-highlight-bg-resolved)` form — confirmed this compiles to `background-color:var(--code-highlight-bg-resolved)`.
- Plugin utilities (`zoom-in-[0.97]`, `zoom-out-[0.97]`, `slide-in-from-top-[1%]`, `slide-out-to-top-[1%]`, plus their siblings `animate-in`/`animate-out`/`fade-in-0`/`fade-out-0`): **DEAD CLASSES, zero rendered CSS.** Grepping the built `storybook-static` CSS for any of these class names (in escaped or unescaped form) returns nothing — not even the base `animate-in` machinery they depend on. Confirmed via `package.json`/`node_modules` inspection that the `tw-animate-css` plugin is not installed anywhere in this repo, and `ui/src/index.css` defines no matching `@utility` overrides. These utilities have had zero visual effect since before this run started; nothing to tokenize without changing (from nothing to something) a currently inert class, which is out of this batch's zero-visual-change mandate. Left untouched, allowlisted with the reasoning above.
- `theme(colors.muted.DEFAULT)` / `theme(colors.muted.foreground)` fallback resolution: inspected the ALREADY-BUILT `ui/storybook-static/assets/*.css` before writing the codemod (per the mission's instruction to check build output first, since `theme()` is a build-time function) — confirmed byte-for-byte that Tailwind compiles `bg-[var(--paperclip-code-bg,theme(colors.muted.DEFAULT))]` to `background-color:var(--paperclip-code-bg,var(--muted))` and the gutter-fg sibling to `color:var(--paperclip-code-gutter-fg,var(--muted-foreground))`. Minted `--code-bg-resolved: var(--paperclip-code-bg, var(--muted));` and `--code-gutter-fg-resolved: var(--paperclip-code-gutter-fg, var(--muted-foreground));` reproducing that exact resolved form.

**Sites rewritten: 198**, across 84 files (79 component/page files + 3 test files rewritten in lockstep — `IssueDocumentAnnotations.test.tsx` (`z-[60]` → `z-(--z-60)`, 2 assertion strings), `MarkdownBody.test.tsx` (`align-[-0.125em]` → `align-(--va-0_125em)`, 3 assertion strings), `SidebarShell.test.tsx` (`transition-[width]` → `transition-(--tp-width)`, 1 negative assertion) — plus `AGENTS.md`/`package.json`/`ui/src/index.css` for the gate script wiring and doc updates).

**Tokens minted: 96 new** (58 `--gtc-*` + 3 `--gtr-*` + 19 `--tp-*` + 6 `--z-*` + 1 `--s-*` + 1 `--e-*` + 1 `--va-*` + 1 `--sw-*` + 2 `--blur-*` + 1 `--drop-shadow-extract-*` + 4 `*-resolved` wrapper tokens + 2 `--gradient-extract-*` continuing Batch 1's counter as `-25`/`-26`; 0 reused from Batches 1-3 — no existing token in any prior family matched these new value shapes).
- **`--gtc-*` (58) / `--gtr-*` (3)** — grid-template-columns/rows track lists, verbatim (underscore-to-space reversal applied per Batch 1's gotcha), sequentially numbered (content like `minmax(0,1fr)_auto` isn't safely nameable). Deduped on exact string match: e.g. `--gtr-2`/`--gtr-3` (`1fr`/`0fr`) each reused across both `CompanySkills.tsx` `expanded`/collapsed sites. One pre-existing source oddity preserved verbatim, not "fixed": `pages/Costs.tsx`'s `grid-cols-[1.3fr,1fr]`/`[1.25fr,0.95fr]`/`[1.2fr,0.95fr]` use a literal COMMA between track values (not the standard space-separated `grid-template-columns` syntax) — confirmed via the built CSS that this is exactly what ships today (`grid-template-columns:1.3fr,1fr`), so the token values (`--gtc-31`/`-32`/`-33`) preserve the comma byte-for-byte rather than "correcting" it to a space, per DESIGN.md's no-normalizing rule.
- **`--tp-*` (19)** — `transition-property` lists, slugged from the comma-joined property names (e.g. `--tp-width-background-color: width,background-color;`), one token per distinct property-list string.
- **`--z-*` (6)** — `--z-1`, `--z-2`, `--z-60`, `--z-120`, `--z-200`, `--z-9999`, bare numeric values matching TOKEN-AUDIT.md section 3.7's ad hoc z-index inventory exactly. Still no z-index TIER/scale decision made (per that section's original flag) — these are 6 independent verbatim values, not a scale.
- **`--s-0_98`, `--e-cubic-bezier-0_16-1-0_3-1`, `--va-0_125em`, `--sw-2_3`** — one token each (scale/ease/vertical-align/stroke-width all had exactly one distinct value in scope).
- **`--blur-1px` / `--blur-2px`** — 2 sites, 2 distinct values (`ChatComposer.tsx`'s `backdrop-blur-[1px]`, `IssueChatThread.tsx`'s `backdrop-blur-[2px]`); confirmed both are `backdrop-blur`, not bare `blur` (see gotcha below).
- **`--drop-shadow-extract-1`** — `CompanyPatternIcon.tsx`'s `drop-shadow-[0_1px_2px_rgba(0,0,0,0.65)]`, its own family per Batch 3's logged "needs human decision" (kept separate from `--shadow-extract-*`, which is `box-shadow`; `drop-shadow` is a `filter` function, a different CSS property).
- **4 `*-resolved` wrapper tokens** (`--code-bg-resolved`, `--code-highlight-bg-resolved`, `--code-gutter-fg-resolved`, `--code-highlight-border-resolved`) — all four `FileViewerSheet.tsx` half-migrated `var(--paperclip-code-*, fallback)` sites Batch 1 explicitly deferred as "needs human decision" (see Batch 1's log above) are now resolved: the `--paperclip-code-highlight-bg`/`-border` sites keep their literal rgba/rgb fallback verbatim; the `--paperclip-code-bg`/`-gutter-fg` sites' `theme(colors.muted...)` fallbacks are resolved to the build's own `var(--muted)`/`var(--muted-foreground)` equivalent (see Step 0 spike above). The inline `token-extraction: allowlisted` comment at the site and Batch 1's allowlist doc-comment entry for this file were both updated to note the resolution rather than silently deleting the historical note.
- **`--gradient-extract-25` / `-26`** — SCOPE CORRECTION found during this batch's own bracket sweep, not called out in the original task list: `components/SidebarAccountMenu.tsx` and `pages/ProfileSettings.tsx` each had one `bg-[linear-gradient(...)]` site using `hsl(var(--primary))`/`color-mix(in_oklab,...)` CSS-native color functions rather than raw hex/rgb literals — which is exactly why Batch 1's hand-audited color-literal table (built to avoid false-positiving on issue references like `acme/web#241`) did not catch them; they were never scanned as "color literals" because they contain no hex/rgb/hsl numeric literal, only `var()`/`color-mix()` references. They ARE still value-bearing gradient brackets by gate 2's definition (a CSS value function), so this batch mints 2 more tokens CONTINUING Batch 1's `--gradient-extract-*` counter (picking up at 25, not restarting at 1) rather than creating a parallel family.
- All new tokens live in a fourth non-`@theme` `:root { ... }` block appended to `ui/src/index.css` immediately after Batch 3's block, headed `/* ── Extracted verbatim MISC tokens (Phase 2 Batch 4, design/token-extraction) ── */`, per DESIGN.md (runtime-tunable).

**GOTCHA — `backdrop-blur-[...]` vs bare `blur-[...]` boundary:** the task's "any `blur-[...]`" language and TOKEN-AUDIT.md section 3.7's inventory both describe the 2 sites as `blur-[Npx]`, but the actual class names are `backdrop-blur-[1px]`/`backdrop-blur-[2px]` (a `filter: backdrop-filter` utility, not the plain `filter: blur()` utility). A bare `blur-\[...\]` regex anchored at Batch 3's class-token BOUNDARY does not match `backdrop-blur-[...]` at all, since `blur` there doesn't start at a boundary (it's preceded by `backdrop-`, not whitespace/quote/colon) — caught immediately in this batch's dry run (0 blur sites found on the first pass despite 2 being expected from the inventory) rather than silently mis-tokenizing. Fixed by matching `(backdrop-blur|blur)-\[...\]` as two alternatives sharing one token family, confirmed both compile correctly in the Step 0 spike.

**Sites allowlisted (added to the canonical machine-readable ALLOWLIST block in `ui/src/index.css`, consolidating and reformatting the prior per-batch prose lists into `* allow <path> — <reason>` lines for `scripts/check-token-gates.mjs` to parse):**
1. `components/ui/dialog.tsx` / `components/ui/alert-dialog.tsx` — `zoom-in-[0.97]`/`zoom-out-[0.97]`/`slide-in-from-top-[1%]`/`slide-out-to-top-[1%]` (plus `animate-in`/`animate-out`/`fade-in-0`/`fade-out-0`): dead/no-op classes, no `tw-animate-css` plugin installed, confirmed via built-CSS grep (see Step 0 spike above).
2. `components/ProjectWorkspaceSummaryCard.tsx` (`min-[420px]:`) / `components/FileTree.tsx` (`max-[480px]:`, 2 sites) — arbitrary BREAKPOINT VARIANTS, not values; the variant position cannot reference a CSS custom property (Tailwind resolves variants at build time), so there is nothing to tokenize without changing Tailwind's own variant syntax. Distinct from `rounded-[inherit]` (Batch 3, a keyword) but the same category of "syntactically cannot hold a token reference."
3. **18 `*.test.tsx` files, 43 hex-literal sites (new policy ruling this batch, resolving TOKEN-AUDIT.md section 8 item 10):** `IssueFiltersPopover.test.tsx`, `IssueProperties.test.tsx`, `MarkdownBody.test.tsx`, `MarkdownEditor.test.tsx`, `NewIssueDialog.test.tsx`, `ProjectTile.test.tsx`, `RoutineRunVariablesDialog.test.tsx`, `SidebarCompanyMenu.test.tsx`, `SidebarProjects.test.tsx`, `SidebarStarredProjects.test.tsx`, `CompanyEnvironments.test.tsx`, `ExecutionWorkspaceDetail.test.tsx`, `InviteLanding.test.tsx`, `IssueDetail.test.tsx`, `ProjectDetail.test.tsx`, `ProjectWorkspaceDetail.test.tsx`, `Projects.test.tsx`, `Routines.test.tsx`. Every site is MOCK PROP / MOCK API-RESPONSE DATA (`color: "#hex"` label/project/routine fixtures, `brandColor`/`companyBrandColor` company fixtures, an xterm.js theme-mock assertion mirroring the already-allowlisted `CompanyEnvironments.tsx` production config) — none are Tailwind class strings or CSS-in-JS style declarations. This is the test-file counterpart of the exact category Batch 1 already allowlisted in production source (persisted/functional data, not a rendered CSS value); rewriting them to `var()` strings would make mock fixtures look unlike real API responses without touching a single rendered pixel. Ruling: test-fixture prop/mock-data hex literals are allowlisted as a standing category, one line per file for reviewability.
4. **3 gate-1 false positives found and fixed in the gate script itself, not allowlisted (no real hex color involved):** `ExternalObjectPill.test.tsx`/`IssueProperties.test.tsx`'s `"acme/web#241"`-style issue-reference strings were initially flagged by a naive hex regex (`#241` is 3 valid hex digits) — the exact false-positive shape Batch 1's own color codemod header already documented. Fixed with a negative lookbehind requiring a hex color's `#` not be immediately preceded by an identifier character or `/` (a real CSS color is always preceded by a delimiter — quote, colon, paren, comma, whitespace, backtick, or string start — never glued directly to a slash-path or word).

**Gate script: `scripts/check-token-gates.mjs`** (new, Part C of this batch). Implements the three DONE-WHEN gates over `ui/src/components/**` and `ui/src/pages/**`:
- **Gate 1 (color literals):** hex colors (`#fff`/`#ffffff`/`#ffffffff`) and `rgb()`/`rgba()`/`hsl()`/`hsla()`/`oklch()` calls with a LITERAL first argument (not `var(...)`) — so `hsl(var(--primary)/0.16)` passes, `rgba(0,0,0,0.5)` fails.
- **Gate 2 (arbitrary bracket values):** flags `word-[content]` where `content` carries a rendered value (digits+CSS-unit, bare hex, or a CSS value function — `calc`/`min`/`max`/`clamp`/`var`/`env`/`linear-gradient`/`radial-gradient`/`conic-gradient`/`cubic-bezier`/`rgba?`/`hsla?`/`oklch`/`color-mix`). **Selector/variant brackets are excluded BY DEFINITION** (documented in the script's header, matching the mission's Part B instruction), recognized structurally two ways: (a) known variant-keyword prefixes (`data`, `has`, `aria`, `supports`, `group-data`, `group-has-data`, `group-aria`, `peer-data`, `peer-aria`, `in`, `not`), and (b) any bracket immediately followed by `:` (the structural signature of a breakpoint/arbitrary-variant prefix like `max-[480px]:hidden`, since a value-bearing utility bracket is never itself followed by another `:`-prefixed segment). `rounded-[inherit]` is not flagged (a bare keyword, not a unit/hex/function shape) and is separately allowlisted per Batch 3's precedent for defense-in-depth.
- **Gate 3 (raw font-size):** `text-[Npx]`/`text-[N.Nrem]` class brackets, plus `fontSize: "N..."` / `font-size: "N..."` string-literal declarations that BEGIN with a digit — deliberately excluding `fontSize: "var(--fs-11)"`-style token references (the desired post-extraction form) from matching as a violation.
- **Allowlist parsing:** reads `* allow <repo-relative-path> — <reason>` lines from the canonical ALLOWLIST block appended to the end of `ui/src/index.css` (added this batch, consolidating the Batches 1-3 free-prose lists into this one machine-readable format while leaving the original prose blocks in place as historical narrative). A path suppresses a violation if the violating file's path CONTAINS the allowlisted path as a substring.
- Exit code 0 with a per-gate summary when clean; exit code 1 listing every violation (file:line + snippet), grouped by gate, otherwise.
- Wired as `pnpm check:token-gates` (`"check:token-gates": "node scripts/check-token-gates.mjs"` in the root `package.json`).

**Verify results:**
- Own full bracket sweep (`rg`-based, matching the gate script's boundary logic) over `ui/src/components/**`/`ui/src/pages/**`: only selector/variant brackets (`data-[...]`, `group-data-[...]`, `has-[...]`, `supports-[...]`, etc.) and the documented allowlisted exceptions (`rounded-[inherit]`, `max-[480px]`/`min-[420px]`, the 4 dead tw-animate-css classes) remain.
- `node scripts/check-token-gates.mjs` → **exit 0**, "All gates clean" (Gate 1/2/3 all CLEAN; 468 files scanned; 31 allowlist entries loaded; 71 allowlisted issues correctly skipped rather than flagged).
- `pnpm build-storybook` → exit 0.
- Storybook visual snapshot suite: **510/510 passed** (`npx playwright test --config tests/storybook-visual/playwright.config.ts --reporter=line`) — 509 passed clean on the first attempt + 1 known-benign flaky retry (`product-documents-annotations--integrated-desktop-open [dark]`, the exact flake called out in the batch mandate as expected-benign) passed on Playwright's automatic retry.
- `pnpm typecheck` (from `ui/`) → exit 0.
- Codemod re-run confirmed idempotent: second invocation reports 0 sites rewritten, 0 files changed, token block already present.
- Spot-checked 3 lockstep test-file rewrites directly with `npx vitest run` (`IssueDocumentAnnotations.test.tsx`, `MarkdownBody.test.tsx`, `SidebarShell.test.tsx`): 67/67 tests passed.

**AGENTS.md:** the existing "Design system" section (added before Phase 2 began) was extended with one sentence naming `pnpm check:token-gates` as the required pre-commit check and clarifying the rule's exact scope (`ui/src/components/**`/`ui/src/pages/**`, allowlist-exempted) — kept to the section's existing brief tone, no new section added.

**Remaining out-of-scope debt (explicitly NOT addressed by this run, flagged for whoever scopes the next one):**
- **`ui/src/lib/`, `ui/src/context/`, `ui/src/plugins/`** were never in scope for any of the 4 batches (DESIGN.md/GOAL-PROMPT.md's Phase 2 spec and every batch mandate scoped strictly to `ui/src/components/**` and `ui/src/pages/**`). A quick count at the end of this batch: **36 hex-literal sites** remain in `lib`/`context`/`plugins` combined (`lib/color-contrast.ts`, `lib/worktree-branding.ts`, `context/ThemeContext.tsx` and others — the same "contrast-pair triplication" TOKEN-AUDIT.md section 8 item 9 already flagged). These are helper/logic modules, not component render code, so they were correctly out of this run's gate — but they are real remaining hardcoded-value debt in `ui/src/` overall, and DESIGN.md's "single token source" principle would eventually want them re-pointed at the same tokens too.
- **The Tailwind-palette-class scope question** (TOKEN-AUDIT.md section 8 item 1: `bg-red-500`-style classes, ~3,115 sites / 145 files) was never resolved by any batch and remains exactly as open as it was after Phase 1 — none of Batches 1-4 touched Tailwind's own built-in palette utilities (only literal hex/rgb/bracket-arbitrary values were extracted). This is still the single largest scope decision a human needs to make before any further token-extraction work: whether Tailwind's own oklch palette counts as "hardcoded" under DESIGN.md principle 2, or is considered part of the token system already (Tailwind's palette is itself a fixed design-token set, just not `index.css`'s).
- The micro type-size cluster (9-15px, TOKEN-AUDIT.md section 8 item 2), letter-spacing cluster (item 3), and radius 0px/lg/xl conflict (item 4) are all still open — this run intentionally minted verbatim tokens for every distinct value without collapsing any of them into a real scale, per DESIGN.md's explicit "ugly values stay ugly" instruction. The human scale-collapse decision (GOAL-PROMPT.md "after the run" step 2) is unchanged by Batch 4.
