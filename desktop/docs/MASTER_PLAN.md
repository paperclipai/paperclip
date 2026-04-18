# ArchonOS — Master Plan (Source of Truth)

## Context

**What:** Build ArchonOS, a macOS desktop application using Tauri v2 (Rust backend + React/TypeScript frontend), inspired by Paperclip's AI agent orchestration platform.

**Why:** Paperclip is a powerful web-based agent orchestration tool but lacks native desktop presence. ArchonOS reimagines the experience as a local-first, macOS-native application with expanded capabilities: system integration, personal automation, visual workflow building, and local AI support.

**Core identity:** Agent team orchestration (keep Paperclip's core) + expanded desktop capabilities. Premium, original UX designed for non-technical users — a 91-year-old should find it intuitive.

**Prerequisite:** Rust toolchain must be installed (`rustup`). No Rust/Cargo configuration currently exists in the repo.

---

## Architecture Overview

```
ArchonOS (Tauri v2)
├── Rust Backend (src-tauri/)
│   ├── Tauri Commands (replaces Express routes)
│   ├── SQLite via sqlx (replaces PostgreSQL/Drizzle)
│   ├── macOS integration (tray, notifications, autostart)
│   ├── Tauri Events (replaces WebSocket live updates)
│   ├── Adapter host (spawns agent processes via shell plugin)
│   ├── Heartbeat scheduler (tokio-based, replaces Node.js scheduler)
│   ├── Plugin host (web workers Phase 1-3, WASM Phase 4+)
│   └── Local AI runtime (candle/llama.cpp, Phase 5)
└── React Frontend (src/)
    ├── ArchonOS shell (custom title bar, navigation, layout)
    ├── Design system (tokens, primitives, behavioral UX)
    ├── Tauri IPC adapter (invoke() replaces fetch())
    ├── State: React Query (server state) + React Context (UI state)
    ├── Live updates via Tauri events (replaces WebSocket)
    └── Reused: @paperclipai/shared types, Radix primitives
```

### Key Architectural Decisions

| Decision | Choice | Rationale | Risk & Fallback |
|----------|--------|-----------|-----------------|
| **Database** | Embedded SQLite via `sqlx` (sqlite feature, runtime-tokio) | Zero-config, local-first, single file at `~/Library/Application Support/com.archonos.app/archonos.db` | Risk: Schema translation from PostgreSQL may miss edge cases. Fallback: JSON columns for arrays, FTS5 for full-text search |
| **IPC** | Tauri commands + events | Direct function calls, no HTTP overhead, type-safe with serde | Risk: Tauri v2 API instability. Fallback: Pin exact version |
| **Frontend state** | React Query for server state, React Context for UI state | Proven pattern already working in the Paperclip codebase | Low risk |
| **Component reuse** | Import `@paperclipai/shared` as pnpm workspace dep. Copy UI primitives from `ui/src/components/ui/` | Types stay in sync; UI can diverge | Risk: Drift. Mitigation: Keep copies minimal |
| **Auth** | No auth in Phase 1-2. Phase 3+ adds optional biometric lock via `tauri-plugin-biometric` | Desktop is single-user, local-only | Low risk |
| **Window** | Frameless with custom title bar | Premium feel | Risk: Traffic light bugs. Fallback: `decorations: true` |
| **Adapters** | Reuse `@paperclipai/adapter-*` TypeScript packages. Execute via Tauri shell plugin (process spawning) | Adapters already work by spawning local CLI processes — compatible with desktop | Risk: Some adapters may assume Express context. Test each individually |
| **Live updates** | Tauri events (`app.emit()` from Rust, `listen()` in TS) | Replaces WebSocket. Same fan-out pattern, simpler | Low risk |

### Conventions Mapping (Paperclip → ArchonOS)

| Paperclip Pattern | ArchonOS Equivalent |
|-------------------|---------------------|
| Service factory: `serviceName(db: Db)` → plain object of async methods | Rust module with functions taking `&SqlitePool` parameter |
| Route factory: `xxxRoutes(db, opts?)` → `express.Router` | Tauri commands registered in `lib.rs` |
| Module-level `Map` singletons (concurrency locks, process tracking) | `Arc<Mutex<HashMap>>` stored in Tauri `app.manage()` state |
| Zod validation middleware | Serde deserialization + custom validation in Rust commands |
| `logActivity()` on all mutations | Insert into `activity_log` table after each write |
| Two-actor auth: `assertCompanyAccess()` | Simplified: desktop is single-user, skip auth checks. Store active company in app state |
| `@paperclipai/shared` types/constants | Import as pnpm workspace dep for frontend. Rust structs mirror shapes via serde |
| Adapter session resume by `(sessionId, cwd)` | Same pattern in Rust adapter host — retry with fresh session on unknown-session error |

### Error Handling Strategy

**Rust → Frontend:** Every Tauri command returns `Result<T, String>`. The frontend `tauri-client.ts` wraps `invoke()` and converts errors into `ApiError` matching Paperclip's shape (`ui/src/api/client.ts:3-13`). React Query error handling works unchanged.

**Frontend:** React Error Boundary at AppShell level + per-page boundaries for isolation.

### PostgreSQL → SQLite Translation Rules

| PostgreSQL | SQLite Equivalent |
|------------|-------------------|
| `UUID` | `TEXT` (store as string, generate with `uuid` crate) |
| `SERIAL` / `BIGSERIAL` | `INTEGER PRIMARY KEY AUTOINCREMENT` |
| `JSONB` | `TEXT` (store as JSON string, query with `json_extract()`) |
| `text[]` (arrays) | `TEXT` (store as JSON array) |
| `TIMESTAMPTZ` | `TEXT` (ISO 8601 format, e.g., `2024-01-15T10:30:00Z`) |
| `BIGINT` | `INTEGER` (SQLite integers are 64-bit) |
| `BOOLEAN` | `INTEGER` (0/1) |
| GIN index (full-text) | FTS5 virtual table |
| `LISTEN/NOTIFY` | Tauri events (emit from Rust after write) |

---

## UI/UX Design System — "Clarity Architecture"

### Visual Signature

ArchonOS's identity comes from **quiet authority**: the interface communicates competence through restraint, not decoration. Recognize it by:
- **Monochrome foundation with a single accent**: Almost entirely neutral grays. The slate-blue accent (`oklch hue 250`) appears only on active indicators, primary actions, and focus rings — never as backgrounds or decorative fills.
- **Typography**: DM Sans (body) + JetBrains Mono (data/code). DM Sans's optical sizing gives it warmth at body size and sharpness at headings — it avoids the clinical feel of system fonts without being trendy.
- **Layered depth, not borders**: Cards and regions differentiate via subtle background shifts (2-4% lightness steps), not heavy borders. Borders exist but at very low contrast (`--border-subtle` is only 3% different from `--bg`).
- **Spatial generosity**: More whitespace than competitors. 48px list rows, 32px content padding. Content breathes.
- **Status through color temperature**: Green (cool, calm: success), amber (warm: attention), red (hot: urgent). The accent blue sits outside this temperature scale, reserved for *user intent* not *system state*.

---

### Principles (9 total)

#### 1. Progressive Disclosure
*Science: Hick's Law — decision time increases logarithmically with choices.*

| Surface | What's visible | What's hidden | Reveal mechanism |
|---------|---------------|---------------|-----------------|
| NavigationRail | 6 section icons | Section content | Click → sidebar populates |
| Agent list | Name, role, status, spend | Config, budget policy, permissions, run history | Click row → detail page with tabs |
| Agent detail | Overview tab (name, status, recent runs) | Configuration, Runs, Budget tabs | Tab navigation |
| Issue detail | Title, status, comments | Execution policy, documents, workspace | Tab navigation |
| Settings | Appearance section | Advanced, adapters, plugins | Scroll / section expand |
| Command palette | Navigation commands | Agent-specific, issue-specific actions | Type to filter |

**Rule:** No view shows more than 7±2 primary actions. Secondary actions live in overflow menus or tabs.

#### 2. Spatial Consistency
*Science: Cognitive mapping (Tolman, 1948) — users build spatial memory.*

**Fixed layout regions (never move):**
```
┌──────────────────────────────────────────────┐
│ TitleBar (38px) — drag region + breadcrumbs   │
├──────┬────────┬──────────────────────────────┤
│ Rail │Sidebar │ Main Content                 │
│ 56px │ 240px  │ flex-1, overflow-y: auto     │
│      │collaps.│                              │
│      │        │                              │
│      │        │                              │
└──────┴────────┴──────────────────────────────┘
```
- Rail: always left edge, always 6+1 icons in same order (Dashboard, Agents, Projects, Issues, Workflows, Goals | Settings)
- Sidebar: always right of rail, same position whether open or collapsed
- Main content: always right of sidebar
- Command palette: always centered, always 520px wide
- Toasts: always bottom-center
- Dialogs: always centered with overlay

**Navigation direction:**
- Drilling down (list → detail) = content slides **left** (new content enters from right)
- Going back (detail → list) = content slides **right** (previous content returns from left)
- Tab switching = **crossfade** (no directional bias)

#### 3. Single Active Context
*Science: Attentional bottleneck — humans process one focal task at a time.*

**Rules:**
- One main content view at a time. No split panes, no side-by-side panels.
- Clicking an item in a list replaces the list content with the detail view. A back breadcrumb restores the list.
- Modal dialogs dim everything behind them. Only one modal at a time.
- Command palette closes any open dialog before appearing.
- The active NavigationRail icon has a 3px×20px accent pill on its left edge (animated in with 150ms spring ease).

**Exception:** The sidebar is contextual (its content changes with the active section) but its *position* never changes. This is considered stable context, not a competing focus.

#### 4. Legibility Over Density
*Science: Age-related visual acuity decline; Fitt's Law for target sizing.*

| Element | Minimum | Specification |
|---------|---------|--------------|
| Body text | 14px | DM Sans 400, line-height 1.5 (21px) |
| Secondary text | 12px | DM Sans 400, used only for metadata, timestamps, counts |
| Label text | 11px | DM Sans 600, uppercase, letter-spacing 0.06em, used only for section headings |
| Headings | 20px | DM Sans 600, letter-spacing -0.01em |
| Page titles | 28px | DM Sans 600, letter-spacing -0.02em |
| Click targets | 36px height | Desktop minimum; 44px if touch input detected |
| List rows | 48px height | With 16px horizontal padding |
| Nav rail icons | 40×40px | 20px icon centered in 40px hit area |
| Contrast (primary text) | 7:1 | WCAG AAA against `--bg` |
| Contrast (secondary text) | 4.5:1 | WCAG AA against `--bg` |
| Max items before pagination | 50 | Virtualize with `react-window` beyond this |
| Max content width | 960px | Centered in main content; prevents eye-tracking strain on wide monitors |

#### 5. Honest Affordances
*Science: Norman's affordance theory (The Design of Everyday Things).*

**Button hierarchy:**
| Level | Style | When to use |
|-------|-------|------------|
| Primary | Filled accent bg, white text, 6px radius | One per view. The main action: "New Agent", "Save", "Approve" |
| Secondary | Outlined (1px `--border`), `--fg-secondary` text | Supporting actions: "Cancel", "Export", "Filter" |
| Ghost | No border, no fill, `--fg-muted` text, hover shows `--bg-muted` | Toolbar actions, icon buttons, less important controls |
| Destructive | Outlined `--destructive`, destructive text | Delete, terminate, revoke. Never filled (reduce accidental clicks) |

**Interactive state rules:**
| State | Visual treatment |
|-------|-----------------|
| Default | Resting appearance as defined above |
| Hover | Immediate (no delay). Background shift or border color change. Cursor: pointer |
| Active/pressed | Scale 0.98 + darken 5% for 100ms |
| Focus-visible | 2px `--accent` ring with 2px offset. Applied via `:focus-visible` (keyboard only, not mouse click) |
| Disabled | 40% opacity, `cursor: not-allowed`. Never remove from DOM — screen readers still announce it |
| Loading | Content replaced with skeleton shimmer or spinner. Button shows inline spinner + "Loading..." text |

**Drag affordances:** Draggable elements show a 6-dot grip icon on hover (left side).

#### 6. Calm Notification
*Science: Calm technology (Weiser & Brown, 1996).*

**Notification tiers:**

| Tier | Channel | Duration | When |
|------|---------|----------|------|
| **Ambient** | Status dot next to entity name | Persistent | Agent status (green=active, amber=paused, red=error, blue-pulsing=running) |
| **Informational** | Toast (bottom-center) | 3s auto-dismiss | Task completed, config saved, agent resumed |
| **Attention** | Toast + persist until dismissed | Until user acts | Budget warning (80% threshold), approval request received |
| **Urgent** | macOS native notification + toast | Until user acts | Budget hard-stop, agent runtime error, approval rejected |

**Anti-patterns (never do):**
- No badge counts on NavigationRail icons (reduces anxiety, avoids "notification debt")
- No sound effects
- No modal alerts for non-destructive events
- No red color for non-error states
- No blinking or bouncing animations (pulse-dot animation is subtle: opacity 1→0.4→1 over 2s)

**Color-blind safety:** Status is communicated through dot color AND position/label. On the agent list, the status badge includes both a dot AND a text label ("Running", "Paused", "Error"). Never rely on color alone.

#### 7. Forgiving Interaction
*Science: Error recovery research — reducing fear of mistakes encourages exploration.*

**Destructive action protocol:**
1. Click delete → confirmation dialog appears with entity name in bold ("Delete agent **Atlas**?")
2. User confirms → toast appears: "Agent deleted · **Undo**" (5s timeout)
3. During 5s window: soft-delete (set `hidden_at`). Undo restores it.
4. After 5s: hard delete. Toast disappears.

**Form preservation:**
- All form inputs auto-save to localStorage every 2s, keyed by `archonos.draft.{formId}`
- Drafts survive: accidental dialog close, page navigation, app crash, restart
- Drafts cleared on successful submit

**Error message format:** Always two parts:
```
[What happened] — [What to do next]
```
Examples:
- "Agent failed to start — Check that the API key is valid in Settings > Adapters"
- "Budget limit reached — Increase the monthly budget or approve the overage"
- "Network unavailable — Changes will sync when you're back online"

#### 8. Information Hierarchy
*Science: Visual hierarchy research (Gestalt principles, F-pattern scanning).*

Each view follows a consistent top-to-bottom hierarchy:

| Level | Element | Treatment |
|-------|---------|-----------|
| 1 | Page title | 20-28px, DM Sans 600, left-aligned |
| 2 | Primary action | Button in page header, right-aligned opposite title |
| 3 | Filters/tabs | Below header, full-width, `--border` bottom line |
| 4 | Content list/cards | Main body, each row is a self-contained unit |
| 5 | Metadata | Right-aligned in rows, monospace for numbers, muted color |
| 6 | Footer/status | Bottom of region, smallest text, most muted color |

**Cognitive load budget:** No single view presents more than:
- 1 primary action button
- 5 filter options visible without expanding
- 7 columns in any table/list
- 50 rows without pagination/virtualization

#### 9. Responsive Feedback
*Science: Doherty threshold (system response <400ms feels instant) and progressive feedback.*

Every user action produces visible feedback within 100ms:

| Action | Immediate feedback (< 100ms) | Completion feedback |
|--------|------------------------------|---------------------|
| Button click | Active state (scale 0.98) | Result appears / toast / navigation |
| Form submit | Button shows spinner | Success toast or inline validation |
| Navigation | Rail pill animates to new icon | Page content slides in (150ms) |
| Toggle | Switch snaps to new state | — (instant, no async) |
| Drag start | Element lifts (shadow L2), cursor changes | Drop target highlights |
| Long operation (>2s) | Skeleton loading state | Content replaces skeleton with fade-in |
| Delete | Item fades out (150ms) | Undo toast appears |

**Loading states:**
- **Skeleton shimmer** for content that has a known layout (lists, cards, detail pages). Skeleton shape mirrors the real content.
- **Centered spinner** only for unknown-layout content (initial app load, first-time data fetch).
- **Inline spinner** on buttons during async actions.
- Never show a blank white/dark screen. Always show skeleton or placeholder.

---

### Design Tokens (Complete Reference)

**Source of truth:** These tokens are implemented as CSS custom properties. The mockup at `desktop/mockup/index.html` is the living reference.

#### Typography

| Token | Value | Usage |
|-------|-------|-------|
| `--font-body` | `'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif` | All UI text |
| `--font-mono` | `'JetBrains Mono', ui-monospace, monospace` | Code, data values, IDs, costs, token counts |
| Font scale | 11 / 12 / 13 / 14 / 16 / 20 / 24 / 28 / 32 px | 11px reserved for section labels only |
| Weight 400 | Regular | Body text, descriptions |
| Weight 500 | Medium | Navigation items, labels, card titles, buttons |
| Weight 600 | Semibold | Page headings, section titles, emphasis |

#### Colors (oklch — light / dark)

**Core surfaces:**
| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `--bg` | `oklch(0.985 0 0)` | `oklch(0.13 0 0)` | Page background |
| `--bg-subtle` | `oklch(0.97 0 0)` | `oklch(0.16 0 0)` | Hover backgrounds, alternating rows |
| `--bg-muted` | `oklch(0.95 0 0)` | `oklch(0.19 0 0)` | Disabled fills, section backgrounds |
| `--fg` | `oklch(0.145 0 0)` | `oklch(0.93 0 0)` | Primary text |
| `--fg-secondary` | `oklch(0.45 0 0)` | `oklch(0.65 0 0)` | Secondary text, descriptions |
| `--fg-muted` | `oklch(0.58 0 0)` | `oklch(0.50 0 0)` | Placeholder text, disabled text, timestamps |

**Borders:**
| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `--border` | `oklch(0.91 0 0)` | `oklch(0.22 0 0)` | Visible borders, dividers |
| `--border-subtle` | `oklch(0.94 0 0)` | `oklch(0.19 0 0)` | Region separators (rail, sidebar, titlebar) |

**Accent (slate-blue, hue 250):**
| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `--accent` | `oklch(0.50 0.14 250)` | `oklch(0.60 0.15 250)` | Primary buttons, active indicators, focus rings |
| `--accent-hover` | `oklch(0.45 0.16 250)` | `oklch(0.65 0.17 250)` | Primary button hover |
| `--accent-subtle` | `oklch(0.95 0.03 250)` | `oklch(0.20 0.04 250)` | Active sidebar item bg, selected row bg |
| `--accent-fg` | `oklch(0.99 0 0)` | `oklch(0.99 0 0)` | Text on accent backgrounds |

**Semantic status:**
| Token | Light | Dark | Meaning |
|-------|-------|------|---------|
| `--success` / `--success-subtle` | `oklch(0.55 0.18 155)` / `oklch(0.95 0.04 155)` | `oklch(0.60 0.18 155)` / `oklch(0.20 0.04 155)` | Active, completed, healthy |
| `--warning` / `--warning-subtle` | `oklch(0.70 0.15 75)` / `oklch(0.95 0.04 75)` | `oklch(0.72 0.15 75)` / `oklch(0.20 0.04 75)` | Paused, attention needed |
| `--destructive` / `--destructive-subtle` | `oklch(0.55 0.22 25)` / `oklch(0.95 0.04 25)` | `oklch(0.60 0.22 25)` / `oklch(0.20 0.04 25)` | Error, delete, terminate |

**Component surfaces:**
| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `--rail-bg` | `oklch(0.975 0 0)` | `oklch(0.11 0 0)` | Navigation rail background |
| `--sidebar-bg` | `oklch(0.98 0 0)` | `oklch(0.12 0 0)` | Sidebar background |
| `--card-bg` | `oklch(1.0 0 0)` | `oklch(0.16 0 0)` | Card, row, dialog background |
| `--card-border` | `oklch(0.92 0 0)` | `oklch(0.22 0 0)` | Card border |
| `--input-bg` | `oklch(0.98 0 0)` | `oklch(0.18 0 0)` | Input field background |
| `--input-border` | `oklch(0.88 0 0)` | `oklch(0.26 0 0)` | Input field border |
| `--skeleton` | `oklch(0.93 0 0)` | `oklch(0.20 0 0)` | Skeleton loading placeholder |

#### Spacing

4px base unit. Named tokens:
| Token | Value | Common usage |
|-------|-------|-------------|
| `--sp-1` | 4px | Tight gaps (icon padding, badge padding) |
| `--sp-2` | 8px | Default inner gap, list item padding |
| `--sp-3` | 12px | Input padding, nav item spacing |
| `--sp-4` | 16px | Card padding, sidebar header padding |
| `--sp-5` | 20px | Card inner padding |
| `--sp-6` | 24px | Section spacing |
| `--sp-8` | 32px | Main content padding, large section gaps |
| `--sp-10` | 40px | — |
| `--sp-12` | 48px | Dashboard greeting margin |
| `--sp-16` | 64px | — |

#### Layout

| Token | Value | Description |
|-------|-------|-------------|
| `--titlebar-h` | 38px | Custom title bar height |
| `--rail-w` | 56px | Navigation rail width |
| `--sidebar-w` | 240px | Sidebar width (0 when collapsed) |

#### Border Radius

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | 4px | Inputs, inline badges |
| `--radius-md` | 6px | Buttons, dropdown items, sidebar items |
| `--radius-lg` | 8px | Cards, dialogs, nav icons hover |
| `--radius-pill` | 9999px | Status badges, pills, toggles |

#### Elevation (Shadows)

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `--shadow-1` | `0 1px 3px oklch(0 0 0 / 0.08)` | `0 1px 3px oklch(0 0 0 / 0.3)` | Cards on hover, dropdowns |
| `--shadow-2` | `0 4px 16px oklch(0 0 0 / 0.12)` | `0 4px 16px oklch(0 0 0 / 0.4)` | Dialogs, popovers, drag-lifted items |
| `--shadow-3` | `0 8px 32px oklch(0 0 0 / 0.18)` | `0 8px 32px oklch(0 0 0 / 0.5)` | Command palette |

#### Motion

| Token | Value | Usage |
|-------|-------|-------|
| `--ease-default` | `cubic-bezier(0.25, 0.1, 0.25, 1)` | Most transitions |
| `--ease-spring` | `cubic-bezier(0.16, 1, 0.3, 1)` | Enter animations, sidebar toggle, nav pill |
| `--duration-fast` | 100ms | Hover states, active press, micro-interactions |
| `--duration-normal` | 150ms | Sidebar toggle, tab transitions, content slide |
| `--duration-slow` | 250ms | Page changes, dialog enter/exit, toast in/out |

`@media (prefers-reduced-motion: reduce)` → all durations set to 0ms.

#### Z-Index Scale

| Layer | Value | Elements |
|-------|-------|----------|
| Base | 0 | Default content |
| Sticky | 10 | Sticky headers, breadcrumb bar |
| Sidebar overlay | 40 | Mobile sidebar backdrop |
| Sidebar | 50 | Mobile sidebar (above overlay) |
| Dropdown | 60 | Dropdown menus, popovers, tooltips |
| Dialog overlay | 90 | Dialog backdrop |
| Dialog | 95 | Dialog content |
| Command palette | 100 | Command palette (above everything) |
| Toast | 200 | Toast notifications (above command palette) |

---

### Component Pattern Library

#### Status Badge
```
[●  Label]          — dot (6px) + text (12px, 500 weight)
                     — border-radius: pill
                     — background: --{status}-subtle
                     — color: --{status}
```
Variants: `running` (blue, pulsing dot), `active` (green), `paused` (amber), `error` (red), `idle` (muted gray)

#### List Row
```
┌─────────────────────────────────────────────────┐
│ [Icon 36px] [Title 14px/500]    [Meta]  [Badge] │
│             [Subtitle 12px/muted]               │
└─────────────────────────────────────────────────┘
Height: 48px+ (auto). Padding: 16px horizontal, 12px vertical.
Hover: --bg-subtle. Border: bottom 1px --border-subtle.
Click: entire row is interactive (cursor: pointer).
```

#### Card
```
┌─────────────────────────────────────────────────┐
│ [Icon 40px]  [Title 14px/500]          [Arrow →]│
│              [Description 13px/muted]           │
└─────────────────────────────────────────────────┘
Background: --card-bg. Border: 1px --card-border. Radius: --radius-lg.
Padding: 20px 24px. Hover: border-color --accent, shadow-1, translateY(-1px).
```

#### Empty State
```
         [Icon 48px, 40% opacity]
       [Title 15px/500, --fg-secondary]
     [Description 13px, --fg-muted]
        [Optional: Primary button]
```
Centered vertically and horizontally in the content area. Max-width 320px.

#### Dialog
```
Overlay: oklch(0 0 0 / 0.4), z-index 90
Dialog: --card-bg, radius-lg, shadow-3, z-index 95
Width: 480px (small), 640px (medium), 800px (large)
Enter: scale 0.97 → 1.0 + fade, 150ms spring
Exit: fade out, 100ms
Focus trap: tab cycles within dialog. Escape closes.
```

### Accessibility Requirements

| Requirement | Specification |
|-------------|--------------|
| **Keyboard navigation** | All interactive elements reachable via Tab. Arrow keys within component groups (nav rail, tabs, menu items). Enter/Space to activate. Escape to close overlays. |
| **Focus management** | `:focus-visible` ring (2px accent, 2px offset) on keyboard navigation only. Focus moves to dialog on open, returns to trigger on close. |
| **Screen readers** | All icons have `aria-label`. Status dots have `aria-label` (e.g., "Status: running"). Live regions (`aria-live="polite"`) for toasts. `role="alert"` for errors. |
| **Color independence** | Status always communicated via color + text label. Never color alone. Priority bars have distinct widths in addition to color. |
| **Reduced motion** | `prefers-reduced-motion: reduce` → all transitions instant (0ms). Animations disabled. |
| **Font scaling** | UI tested at 100%, 125%, and 150% browser zoom. No content clipping or overflow. Relative units (`rem`) for spacing that should scale with text. |
| **Minimum target size** | 36×36px for desktop, 44×44px for touch. Verified via audit. |

---

## Project Structure

```
tirana/
  desktop/                              # NEW — ArchonOS desktop app
    package.json                        # @archonos/desktop
    vite.config.ts                      # Vite 6 + Tailwind 4 + Tauri env
    tsconfig.json                       # Extends ../../tsconfig.base.json
    index.html                          # Tauri webview entry
    src-tauri/                          # Rust backend
      Cargo.toml
      tauri.conf.json
      capabilities/default.json
      icons/
      build.rs
      src/
        main.rs
        lib.rs                          # Command registration
        commands/
          mod.rs
          system.rs                     # health_check, get_platform
          settings.rs                   # get/update settings
          companies.rs                  # Phase 2+
          agents.rs                     # Phase 2
          issues.rs                     # Phase 3
          projects.rs                   # Phase 3
          goals.rs                      # Phase 3
          approvals.rs                  # Phase 3
          costs.rs                      # Phase 3
          routines.rs                   # Phase 4
          workflows.rs                  # Phase 4
          plugins.rs                    # Phase 5
          local_ai.rs                   # Phase 5
          automation.rs                 # Phase 5
        db/
          mod.rs                        # Pool init + migration runner
          migrations/                   # SQL migration files per phase
        services/
          mod.rs
          heartbeat.rs                  # Phase 2 — agent scheduling
          adapter_host.rs               # Phase 2 — process spawning
          routine_scheduler.rs          # Phase 4 — cron scheduling
          plugin_host.rs                # Phase 5 — plugin runtime
          local_ai.rs                   # Phase 5 — model runtime
        events.rs                       # Typed event emitter
        menu.rs                         # macOS application menu
        tray.rs                         # System tray
    src/                                # React frontend
      main.tsx
      App.tsx
      api/
        tauri-client.ts                 # invoke() wrapper
        agents.ts                       # Phase 2
        issues.ts                       # Phase 3
        projects.ts                     # Phase 3
        goals.ts                        # Phase 3
        approvals.ts                    # Phase 3
        costs.ts                        # Phase 3
        routines.ts                     # Phase 4
      components/
        shell/                          # AppShell, TitleBar, NavigationRail, Sidebar, CommandPalette, ErrorBoundary
        ui/                             # Copied Radix primitives
        agents/                         # Phase 2 — agent-specific components
        issues/                         # Phase 3 — issue-specific components
        projects/                       # Phase 3
        workflows/                      # Phase 4
      context/
        ThemeContext.tsx
        SidebarContext.tsx
        LiveUpdatesContext.tsx           # Phase 2 — Tauri event consumer
      hooks/
        useTauriEvent.ts
        useTauriInvoke.ts
      lib/
        utils.ts
      pages/                            # All pages across all phases
      styles/
        index.css
```

---

## Phase 1: The Shell

### Goal
A working Tauri v2 desktop app with premium layout, design system, navigation, and macOS integration. No domain features — just the container.

### Step 0: App Icon & Assets
1. Create `desktop/src-tauri/icons/` directory
2. Generate placeholder 1024x1024 PNG icon (geometric "A" mark)
3. Run `pnpm tauri icon` to generate all sizes + `icon.icns`
4. Create 22x22 monochrome tray template icon

**Verify:** `icons/` contains `icon.icns`, `icon.png`, and size variants.

### Step 1: Prerequisites & Scaffold
1. Verify Rust ≥ 1.77.0: `rustc --version`. Install if missing.
2. Install Tauri CLI: `cargo install tauri-cli --version "^2"`
3. Create `desktop/package.json` with:
   - `react@^19`, `react-dom@^19`, `react-router@^7.1`, `@tanstack/react-query@^5`
   - `@tauri-apps/api@^2`, `@tauri-apps/plugin-shell@^2`, `@tauri-apps/plugin-notification@^2`
   - `tailwindcss@^4`, `@tailwindcss/vite@^4`, `cmdk@^1.1`, `lucide-react@^0.574`
   - `clsx@^2`, `tailwind-merge@^3`, `class-variance-authority@^0.7`
   - Radix UI: dialog, tooltip, dropdown-menu, popover, scroll-area, separator, tabs
   - devDeps: `vite@^6`, `@vitejs/plugin-react@^4`, `typescript@^5.7`, `@tauri-apps/cli@^2`
4. Create `desktop/src-tauri/Cargo.toml`:
   - `tauri = { version = "2", features = ["macos-private-api"] }`
   - `tauri-plugin-shell = "2"`, `tauri-plugin-notification = "2"`, `tauri-plugin-autostart = "2"`
   - `sqlx = { version = "0.8", features = ["runtime-tokio", "sqlite"] }`
   - `serde = { version = "1", features = ["derive"] }`, `serde_json = "1"`, `tokio`, `dirs = "6"`
5. Create `tauri.conf.json` (frameless, 1280x800, min 960x600, transparent, macOSPrivateApi)
6. Create `build.rs`: `fn main() { tauri_build::main() }`
7. Add `- desktop` to `pnpm-workspace.yaml`
8. `pnpm install` + `cargo check`

**Verify:** `pnpm install` succeeds. `cargo check` succeeds.

### Step 2: Vite + React Entry Point
1. `vite.config.ts` with Tailwind plugin, `@` alias, port 5174, `envPrefix: ["VITE_", "TAURI_"]`
2. `tsconfig.json` extending `../../tsconfig.base.json`
3. `index.html` with `<div id="root">`
4. `main.tsx` with StrictMode, QueryClientProvider, ThemeProvider, BrowserRouter, App
5. `App.tsx` with routes: `/dashboard`, `/agents`, `/projects`, `/issues`, `/settings`

**Verify:** `pnpm vite dev` on port 5174 renders a blank React app.

### Step 3: Design System Foundation
1. `styles/index.css` — Tailwind imports, ArchonOS oklch tokens, base styles, reduced-motion
2. Copy `cn()` from `ui/src/lib/utils.ts`
3. Copy 11 Radix primitives from `ui/src/components/ui/`
4. `ThemeContext.tsx` — localStorage persistence + macOS `prefers-color-scheme` detection

**Verify:** Colors render. macOS theme toggle syncs. Buttons/dialogs work.

### Step 4: App Shell Layout
1. `TitleBar.tsx` — 28px, `data-tauri-drag-region`, 72px traffic light space, search trigger
2. `NavigationRail.tsx` — 56px, 6 icons (Dashboard/Agents/Projects/Issues/Workflows/Goals) + Settings, 4px accent pill, NavLink active detection
3. `Sidebar.tsx` — 240px collapsible (150ms transition), contextual title, scroll-area
4. `AppShell.tsx` — TitleBar + NavigationRail + Sidebar + main content + ErrorBoundary
5. `ErrorBoundary.tsx` — "Something went wrong" + plain language + Reload
6. `SidebarContext.tsx` — sidebarOpen, toggle, localStorage persistence

**Verify:** Navigation works. Sidebar toggles. Layout stable at min window size.

### Step 5: Command Palette
1. `CommandPalette.tsx` — cmdk, Cmd+K, Radix Dialog, 480px wide, navigation + action groups
2. Search filters, arrow key navigation, Enter selects, Escape closes

**Verify:** Cmd+K opens. Typing filters. Navigation works.

### Step 6: Rust Backend Foundation
1. `main.rs` — Tauri Builder + plugins (shell, notification, autostart)
2. `lib.rs` — commands: `health_check`, `get_settings`, `update_settings`
3. `db/mod.rs` — SQLite pool init at `~/Library/Application Support/com.archonos.app/archonos.db`
4. `V001__initial_settings.sql` — settings key-value table
5. `menu.rs` — macOS menu (About, Preferences, Quit, Edit, View, Window)
6. `tray.rs` — tray icon + Show/Quit menu
7. `capabilities/default.json` — core:default, shell:allow-open, notification:default, autostart:default

**Verify:** `cargo build` succeeds. `cargo test` passes.

### Step 7: Tauri IPC Adapter
1. `tauri-client.ts` — `tauriInvoke<T>(command, args)` with ApiError
2. `useTauriInvoke.ts` — React Query wrapper
3. `useTauriEvent.ts` — listen/unlisten lifecycle hook

**Verify:** Settings page calls `health_check` and displays result.

### Step 8: Placeholder Pages & Proof of Life
1. Dashboard (first-run welcome — inspired by `ui/src/components/OnboardingWizard.tsx` 4-step flow but simplified: welcome heading, 3 next-step cards, system status), Agents/Projects/Issues ("Coming soon"), Settings (theme toggle)
2. Wire routes in App.tsx
3. Global shortcuts: Cmd+K (palette), Cmd+B (sidebar), Cmd+, (settings)

**End-to-end verification (13 checks):**
1. `pnpm install` succeeds
2. `cargo build` compiles
3. `pnpm tauri dev` launches window
4. Frameless window at 1280x800
5. Title bar drag works
6. Navigation rail icons navigate + accent pill indicator
7. Sidebar toggles with Cmd+B
8. Command palette: Cmd+K, filter, navigate, Escape
9. Theme syncs with macOS
10. Tray icon with Show/Quit
11. SQLite db created at expected path
12. No console errors
13. Layout stable at 960x600 minimum

---

## Phase 2: Agent Management

### Goal
Full agent lifecycle: create, configure, monitor, pause/resume/terminate. Adapter integration for spawning real AI agents. Heartbeat scheduling. Org chart visualization.

### SQLite Tables (Migration V002)

**agents:**
```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'general',  -- ceo, manager, general, specialist, contractor
  title TEXT,
  icon TEXT,
  status TEXT NOT NULL DEFAULT 'idle',   -- idle, active, running, paused, error, terminated, pending_approval
  reports_to TEXT REFERENCES agents(id),
  capabilities TEXT DEFAULT '{}',        -- JSON
  adapter_type TEXT NOT NULL DEFAULT 'process',
  adapter_config TEXT NOT NULL DEFAULT '{}',  -- JSON
  runtime_config TEXT NOT NULL DEFAULT '{}',  -- JSON
  budget_monthly_cents INTEGER NOT NULL DEFAULT 0,
  spent_monthly_cents INTEGER NOT NULL DEFAULT 0,
  pause_reason TEXT,
  paused_at TEXT,
  permissions TEXT NOT NULL DEFAULT '{}', -- JSON
  last_heartbeat_at TEXT,
  metadata TEXT DEFAULT '{}',            -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_agents_company_status ON agents(company_id, status);
CREATE INDEX idx_agents_company_reports ON agents(company_id, reports_to);
```

**heartbeat_runs:**
```sql
CREATE TABLE heartbeat_runs (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  invocation_source TEXT NOT NULL DEFAULT 'on_demand',
  trigger_detail TEXT,
  status TEXT NOT NULL DEFAULT 'queued',  -- queued, running, succeeded, failed, cancelled, timed_out
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  error_code TEXT,
  exit_code INTEGER,
  signal TEXT,
  usage_json TEXT DEFAULT '{}',          -- JSON: tokens, costs
  result_json TEXT DEFAULT '{}',         -- JSON: execution result
  stdout_excerpt TEXT,
  stderr_excerpt TEXT,
  context_snapshot TEXT DEFAULT '{}',     -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_runs_company_agent ON heartbeat_runs(company_id, agent_id, started_at);
```

**agent_runtime_state:**
```sql
CREATE TABLE agent_runtime_state (
  agent_id TEXT PRIMARY KEY NOT NULL REFERENCES agents(id),
  company_id TEXT NOT NULL,
  adapter_type TEXT,
  session_id TEXT,
  state_json TEXT DEFAULT '{}',
  last_run_id TEXT,
  last_run_status TEXT,
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  total_cost_cents INTEGER DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**agent_config_revisions:**
```sql
CREATE TABLE agent_config_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  source TEXT NOT NULL DEFAULT 'patch',  -- patch, rollback, auto_sync
  changed_keys TEXT DEFAULT '[]',        -- JSON array
  before_config TEXT DEFAULT '{}',
  after_config TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**agent_wakeup_requests:**
```sql
CREATE TABLE agent_wakeup_requests (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  source TEXT NOT NULL,
  reason TEXT,
  payload TEXT DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',  -- queued, claimed, finished
  coalesced_count INTEGER NOT NULL DEFAULT 0,
  run_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**execution_workspaces:**
```sql
CREATE TABLE execution_workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(id),
  issue_id TEXT,
  project_workspace_id TEXT,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- active, released, error
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  released_at TEXT
);
```

**activity_log:**
```sql
CREATE TABLE activity_log (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,       -- board, agent, system
  actor_id TEXT,
  action TEXT NOT NULL,           -- created, updated, deleted, etc.
  entity_type TEXT NOT NULL,      -- agent, issue, project, etc.
  entity_id TEXT,
  detail TEXT DEFAULT '{}',       -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_activity_company ON activity_log(company_id, created_at);
```

**companies** (also needed in Phase 2):
```sql
CREATE TABLE companies (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  issue_prefix TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Rust Commands (src-tauri/src/commands/agents.rs)

| Command | Args | Returns | Paperclip equivalent |
|---------|------|---------|---------------------|
| `list_agents` | company_id | `Vec<Agent>` | GET /companies/:id/agents |
| `get_agent` | id | `AgentDetail` | GET /agents/:id |
| `create_agent` | company_id, data | `Agent` | POST /companies/:id/agents |
| `update_agent` | id, data | `Agent` | PATCH /agents/:id |
| `delete_agent` | id | `()` | DELETE /agents/:id |
| `pause_agent` | id, reason | `Agent` | POST /agents/:id/pause |
| `resume_agent` | id | `Agent` | POST /agents/:id/resume |
| `terminate_agent` | id | `Agent` | POST /agents/:id/terminate |
| `wake_agent` | id, source, reason, payload | `HeartbeatRun` | POST /agents/:id/wakeup |
| `get_agent_config` | id | `AgentConfig` | GET /agents/:id/configuration |
| `list_config_revisions` | id | `Vec<ConfigRevision>` | GET /agents/:id/config-revisions |
| `rollback_config` | id, revision_id | `Agent` | POST /agents/:id/config-revisions/:rev/rollback |
| `get_runtime_state` | id | `RuntimeState` | GET /agents/:id/runtime-state |
| `list_heartbeat_runs` | company_id | `Vec<HeartbeatRun>` | GET /companies/:id/heartbeat-runs |
| `get_heartbeat_run` | run_id | `HeartbeatRunDetail` | GET /heartbeat-runs/:id |
| `cancel_heartbeat_run` | run_id | `()` | POST /heartbeat-runs/:id/cancel |
| `get_live_runs` | company_id | `Vec<HeartbeatRun>` | GET /companies/:id/live-runs |
| `get_org_tree` | company_id | `Vec<OrgNode>` | GET /companies/:id/org |
| `list_adapter_models` | adapter_type | `Vec<AdapterModel>` | GET /companies/:id/adapters/:type/models |

### Rust Services (src-tauri/src/services/)

**adapter_host.rs:**
- Spawn agent processes via Tauri's shell plugin (`Command::new()`)
- Map adapter types to CLI commands: `claude_local` → `claude`, `codex_local` → `codex`, etc.
- Pass adapter config (cwd, model, env vars) as CLI arguments
- Capture stdout/stderr, parse exit codes
- Reuse `@paperclipai/adapter-*/server` execution logic patterns but implemented in Rust
- For Phase 2, support: `claude_local`, `process` (generic subprocess), `http` (HTTP request)

**heartbeat.rs** (mirrors `server/src/services/heartbeat.ts` — 35k, the core execution engine):
- Tokio-based tick scheduler (configurable interval, default 30s)
- On tick: query `agent_wakeup_requests` WHERE status = 'queued'
- Full execution flow (from codebase map sequence diagram):
  1. Check concurrency (no duplicate runs) + budget (monthly limit not exceeded)
  2. Call `execution_workspace.realize()` — create git worktree if configured
  3. Start workspace runtime services if configured (dev servers, DBs)
  4. Spawn adapter process via `adapter_host`
  5. Stream stdout/stderr, capture `onLog()` and `onMeta()` events
  6. On exit: record costs, update run status, release runtime services
  7. Emit Tauri events: `agent-run-started`, `agent-run-completed`, `agent-run-failed`
- Coalesce duplicate wakeup requests (increment `coalesced_count`)
- Respect agent status (don't execute if paused/terminated)
- Concurrency locks: `Arc<Mutex<HashMap<AgentId, RunId>>>` in Tauri managed state
- Service dependencies: heartbeat → issues, execution_workspaces, costs, budgets, secrets

**execution_workspaces.rs:**
- Manage ephemeral git worktrees for task isolation
- `realize(agent, issue)` → create worktree from project workspace config (cwd, repo_url, ref)
- `release(workspace_id)` → cleanup worktree after run
- Track active workspaces in `execution_workspaces` SQLite table

**workspace_runtime.rs:**
- Local runtime service processes (dev servers, databases) per workspace
- Start/stop/restart via Tauri shell plugin
- Track running services in `Arc<Mutex<HashMap>>` for cleanup on app quit

### Frontend Pages

**Agents List (pages/Agents.tsx):**
- Status filter tabs: All / Active / Paused / Error (adapted from Paperclip's `Agents.tsx`)
- Agent cards: icon, name, role, adapter type, status dot (per Calm Notification)
- Toggle: List view vs Org Chart view
- "New Agent" button → opens creation dialog
- Sidebar: Lists agents with status indicators, clicking selects and navigates
- Live run indicators: pulsing blue dot if agent has active heartbeat run
- Query key: `["agents", companyId]`, refetch on Tauri event `agent-updated`

**Agent Detail (pages/AgentDetail.tsx):**
- Tabs (per Progressive Disclosure):
  - **Overview** (default): Name, role, status, adapter type, recent runs, activity timeline
  - **Configuration**: Adapter config form (fields vary by adapter type), runtime config
  - **Runs**: Heartbeat run history table with status, duration, cost. Click to expand transcript
  - **Budget**: Monthly spend vs limit, cost chart, budget policy controls
- Pause/Resume/Terminate actions in header
- Config revision history with rollback capability
- Status dot: same color system as list view

**New Agent Dialog (components/agents/NewAgentDialog.tsx):**
- Step 1: Choose adapter type (card selector: Claude, Codex, Cursor, Gemini, OpenCode, Custom)
- Step 2: Configure adapter (dynamic form based on adapter type — cwd, model, API key, etc.)
- Step 3: Set role, name, reports-to (if not first agent — first gets CEO automatically)
- Creates agent via `create_agent` command
- Per Forgiving Interaction: form state preserved if dialog closed accidentally

**Org Chart (pages/OrgChart.tsx):**
- SVG-based tree layout (port from Paperclip's `OrgChart.tsx`)
- Node cards: 200×100px, agent icon + name + role + status dot
- Edges: parent→child lines
- Layout constants: CARD_W=200, CARD_H=100, GAP_X=32, GAP_Y=80
- Data: `get_org_tree` command returns hierarchical structure
- Click node → navigate to agent detail

**Live Updates Integration:**
- Create `context/LiveUpdatesContext.tsx`:
  - Listen to Tauri events: `agent-updated`, `agent-run-started`, `agent-run-completed`, `agent-run-failed`
  - Invalidate relevant React Query caches on each event
  - Show toasts for completions/failures (per Calm Notification: 3s auto-dismiss)
  - Native macOS notification only for errors

### Verification
1. Create a company → appears in sidebar
2. Create an agent (Claude adapter) → appears in agent list with idle status
3. Configure agent with valid API key and cwd
4. Wake agent → status transitions: idle → queued → running → succeeded/failed
5. Heartbeat run appears in Runs tab with stdout excerpt
6. Pause agent → status changes to paused, dot turns amber
7. Resume → back to idle
8. Org chart renders with correct hierarchy
9. Config change creates revision → visible in history → rollback works
10. Live run shows pulsing blue indicator
11. Toast appears on completion/failure
12. Budget displays monthly spend

---

## Phase 3: Projects, Issues, Goals, Approvals & Costs

### Goal
Full project management and governance: issues with lifecycle, project workspaces, goal hierarchy, approval workflows, budget tracking and cost analytics.

### SQLite Tables (Migration V003)

**projects:**
```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL,
  goal_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'backlog',
  color TEXT,
  target_date TEXT,
  lead_agent_id TEXT REFERENCES agents(id),
  env TEXT DEFAULT '{}',
  pause_reason TEXT,
  paused_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**project_workspaces:**
```sql
CREATE TABLE project_workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'local_path',
  cwd TEXT,
  repo_url TEXT,
  repo_ref TEXT,
  default_ref TEXT,
  visibility TEXT,
  setup_command TEXT,
  cleanup_command TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**issues** (49 columns — simplified for core fields):
```sql
CREATE TABLE issues (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  goal_id TEXT,
  parent_id TEXT REFERENCES issues(id),
  issue_number INTEGER NOT NULL,
  identifier TEXT NOT NULL,          -- e.g., "ACME-42"
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'backlog',  -- backlog, todo, in_progress, in_review, blocked, done, cancelled
  priority TEXT NOT NULL DEFAULT 'medium', -- critical, high, medium, low, none
  assignee_agent_id TEXT REFERENCES agents(id),
  origin_kind TEXT,
  billing_code TEXT,
  execution_state TEXT DEFAULT '{}',
  execution_policy TEXT DEFAULT '{}',
  started_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  hidden_at TEXT,
  created_by_agent_id TEXT,
  created_by_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_issues_company_status ON issues(company_id, status);
CREATE INDEX idx_issues_assignee ON issues(company_id, assignee_agent_id, status);
```

**issue_comments:**
```sql
CREATE TABLE issue_comments (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  author_agent_id TEXT,
  author_user_id TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**issue_attachments, issue_labels, issue_relations** — junction tables following same pattern.

**goals:**
```sql
CREATE TABLE goals (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL,
  parent_id TEXT REFERENCES goals(id),
  title TEXT NOT NULL,
  description TEXT,
  level TEXT NOT NULL DEFAULT 'task',   -- mission, objective, key_result, task
  status TEXT NOT NULL DEFAULT 'planned',
  owner_agent_id TEXT REFERENCES agents(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**approvals:**
```sql
CREATE TABLE approvals (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL,
  type TEXT NOT NULL,               -- hire_agent, budget_override, etc.
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, approved, rejected, revision_requested
  requested_by_agent_id TEXT,
  decision_note TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**cost_events:**
```sql
CREATE TABLE cost_events (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL,
  agent_id TEXT,
  issue_id TEXT,
  project_id TEXT,
  heartbeat_run_id TEXT,
  provider TEXT,
  biller TEXT,
  billing_type TEXT,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  cached_input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  billing_code TEXT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_costs_company_agent ON cost_events(company_id, agent_id, occurred_at);
```

**budget_policies, budget_incidents** — following Paperclip's schema pattern.

**Full-text search** (SQLite FTS5):
```sql
CREATE VIRTUAL TABLE issues_fts USING fts5(title, description, identifier, content=issues, content_rowid=rowid);
CREATE VIRTUAL TABLE comments_fts USING fts5(body, content=issue_comments, content_rowid=rowid);
```

### Rust Commands (41+ for issues, 10 for projects, 5 for goals, 10 for approvals, 19 for costs)

**Issues (commands/issues.rs):**
| Command | Purpose |
|---------|---------|
| `list_issues` | List with filters (status, priority, assignee, project, search query) |
| `get_issue` | Issue detail with comments, attachments |
| `create_issue` | Create with auto-numbering (company issue_prefix + sequence) |
| `update_issue` | Update status, priority, assignee, description |
| `delete_issue` | Soft delete (set hidden_at) |
| `list_issue_comments` | Comment thread |
| `create_issue_comment` | Add comment (user or agent authored) |
| `update_issue_comment` | Edit comment body |
| `checkout_issue` | Lock issue for agent execution |
| `search_issues` | FTS5 full-text search on title/description/identifier |

**Projects (commands/projects.rs):**
| Command | Purpose |
|---------|---------|
| `list_projects` | List projects (filter archived) |
| `get_project` | Project detail with workspaces |
| `create_project` | Create project + optional primary workspace |
| `update_project` | Update name, status, lead agent, target date |
| `delete_project` | Archive (set archived_at) |
| `list_project_workspaces` | Workspaces for project |
| `create_project_workspace` | Add workspace (local path or git repo) |

**Goals, Approvals, Costs** — matching Paperclip's route structure.

### Frontend Pages

**Issues List (pages/Issues.tsx):**
- Search bar with FTS support
- Filter pills: status, priority, assignee agent
- Issue rows: identifier (e.g., ACME-42), title, status badge, priority indicator, assignee avatar
- Click → navigates to issue detail (Single Active Context: replaces list)
- "New Issue" button → dialog with title, description, project, assignee, priority
- Sidebar: quick filters, recently viewed issues

**Issue Detail (pages/IssueDetail.tsx):**
- Header: identifier, title (editable inline), status dropdown, priority dropdown
- Tabs:
  - **Comments** (default): Thread with markdown rendering, reply input, agent/user avatars
  - **Activity**: Timeline of status changes, assignments, comments
  - **Documents**: Attached files and work products
- Right properties panel: assignee, project, goal, billing code, dates
- Status transition buttons in header (e.g., "Start Work" → in_progress, "Complete" → done)

**Projects (pages/Projects.tsx):**
- Project cards: name, status, lead agent, issue count, target date
- Click → project detail with tabs: Overview, Issues (filtered to project), Workspaces, Configuration

**Goals (pages/Goals.tsx):**
- Hierarchical tree display (mission → objective → key_result → task)
- Expandable/collapsible nodes
- Status indicators, owner agent

**Approvals (pages/Approvals.tsx):**
- Two tabs: Pending (with count badge), All
- Approval cards: type, requester, payload summary, Approve/Reject buttons
- Decision note input on approve/reject

**Costs (pages/Costs.tsx):**
- Summary tiles: total spend, total tokens, active budget incidents
- Date range picker
- Tabs: By Agent, By Provider, By Model
- Budget policies list with create/edit
- Budget incidents with resolution workflow

**Issue Chat Thread (components/issues/IssueChatThread.tsx):**
- Port from Paperclip's 17k `IssueChatThread.tsx` using `@assistant-ui/react`
- AI chat view with live transcript streaming during agent runs
- Displays agent messages, user messages, and system events in threaded view
- Live streaming: subscribe to Tauri events during active runs
- Fallback: if `@assistant-ui/react` proves too coupled to web, use a simpler chat component with markdown rendering

**Issue Execution Policy (services/issue_execution_policy.rs):**
- Pure state machine for multi-stage issue workflows (from `server/src/services/issue-execution-policy.ts`)
- Stages: draft → in_review → approved → executing → completed
- Gates: require approval before execution, require review before completion
- Configurable per-issue: `execution_policy` JSON field
- Drives the "signoff" workflow visible in issue detail

**Company Portability (services/company_portability.rs):**
- Import/export full company configs as portable JSON bundles
- Export: serialize company + agents + projects + issues + goals + routines + skills → single JSON file
- Import: validate bundle, create all entities, resolve references
- Mirrors Paperclip's `company-portability.ts` (38k — the largest service)
- Desktop advantage: export to local file via Tauri file dialog, import by drag-and-drop

**Markdown Editor:**
- For issue descriptions and comments
- Evaluate: port MDXEditor (heavy, 3.52.4) vs use a lighter markdown editor
- Minimum: syntax highlighting, preview, basic formatting toolbar
- Rendering: `react-markdown` + `remark-gfm` (already dependencies in Paperclip)

### Verification
1. Create project with workspace → appears in list
2. Create issue in project → auto-numbered (PREFIX-1)
3. Full-text search finds issue by title fragment
4. Status transitions work: backlog → todo → in_progress → done
5. Comments thread: add comment, markdown renders correctly
6. Assign agent to issue → agent appears in assignee
7. Create goal hierarchy: mission → objective → task
8. Approval workflow: create → pending → approve/reject
9. Cost events created by heartbeat runs → appear in costs view
10. Budget policy triggers incident when threshold reached
11. Date filtering works on costs page

---

## Phase 4: Routines, Workflows & Automation

### Goal
Scheduled recurring tasks (routines with cron triggers), a visual workflow builder for agent pipelines, and automation infrastructure.

### SQLite Tables (Migration V004)

**routines:**
```sql
CREATE TABLE routines (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  goal_id TEXT,
  parent_issue_id TEXT REFERENCES issues(id),
  title TEXT NOT NULL,
  description TEXT,
  assignee_agent_id TEXT REFERENCES agents(id),
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'active',    -- active, paused, archived
  concurrency_policy TEXT NOT NULL DEFAULT 'coalesce_if_active',
  catch_up_policy TEXT NOT NULL DEFAULT 'skip_missed',
  variables TEXT DEFAULT '[]',              -- JSON: RoutineVariable[]
  created_by_agent_id TEXT,
  created_by_user_id TEXT,
  last_triggered_at TEXT,
  last_enqueued_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_routines_company ON routines(company_id, status);
```

**routine_triggers:**
```sql
CREATE TABLE routine_triggers (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL,
  routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                 -- cron, webhook, manual
  label TEXT,
  cron_expression TEXT,               -- e.g., "0 9 * * 1-5" (9am weekdays)
  timezone TEXT DEFAULT 'UTC',
  next_run_at TEXT,                   -- pre-computed next execution time
  last_fired_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_triggers_next ON routine_triggers(next_run_at) WHERE enabled = 1;
```

**routine_runs:**
```sql
CREATE TABLE routine_runs (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL,
  routine_id TEXT NOT NULL REFERENCES routines(id),
  trigger_id TEXT REFERENCES routine_triggers(id),
  source TEXT NOT NULL,               -- scheduled, manual
  status TEXT NOT NULL DEFAULT 'received',
  triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
  trigger_payload TEXT DEFAULT '{}',
  linked_issue_id TEXT REFERENCES issues(id),
  coalesced_into_run_id TEXT,
  failure_reason TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**workflows** (NEW — not in Paperclip):
```sql
CREATE TABLE workflows (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',  -- draft, active, paused, archived
  graph TEXT NOT NULL DEFAULT '{}',      -- JSON: node/edge graph definition
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY NOT NULL,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  company_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',  -- running, completed, failed, cancelled
  current_node_id TEXT,
  state TEXT NOT NULL DEFAULT '{}',       -- JSON: accumulated state across nodes
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  error TEXT
);
```

### Rust Services

**routine_scheduler.rs:**
- Tokio interval timer (30s tick, matching Paperclip's heartbeat pattern)
- On tick: query `routine_triggers` WHERE `enabled = 1` AND `next_run_at <= now()`
- For each due trigger:
  1. Check concurrency policy (skip if active run exists for `coalesce_if_active`)
  2. Create `routine_runs` entry
  3. Create linked issue (the routine creates an issue for the assignee agent to work on)
  4. Wake the assignee agent via wakeup request
  5. Compute and store `next_run_at` for the trigger
- Catch-up policy: if scheduler was down, `skip_missed` ignores past runs; `enqueue_missed_with_cap` creates up to 25 backfilled runs
- Built-in cron parser: 5-field format (minute hour day month weekday), timezone-aware

**workflow_engine.rs** (NEW):
- Graph execution engine for visual workflows
- Node types:
  - **AgentTask**: Assigns work to an agent, creates an issue, waits for completion
  - **Decision**: Evaluates condition on accumulated state, branches to different nodes
  - **HumanApproval**: Creates approval request, pauses until approved/rejected
  - **Transform**: Runs a data transformation (template string interpolation)
  - **Delay**: Waits for specified duration
  - **Webhook**: Sends HTTP request and captures response
- Execution: async state machine per workflow run
  - `current_node_id` tracks position
  - `state` JSON accumulates outputs from each node
  - On node completion: evaluate outgoing edges, advance to next node
  - On failure: mark run as failed, store error
- Emit Tauri events: `workflow-node-started`, `workflow-node-completed`, `workflow-run-completed`

### Rust Commands

**Routines (commands/routines.rs):**
| Command | Purpose |
|---------|---------|
| `list_routines` | List routines with status filter |
| `get_routine` | Routine detail with triggers and recent runs |
| `create_routine` | Create routine with triggers and variables |
| `update_routine` | Update title, assignee, policies, variables |
| `delete_routine` | Archive routine |
| `list_routine_runs` | Run history for routine |
| `trigger_routine` | Manual trigger with variable overrides |
| `list_routine_triggers` | Triggers for routine |
| `create_routine_trigger` | Add cron/webhook/manual trigger |
| `update_routine_trigger` | Edit trigger (cron expression, enabled) |
| `delete_routine_trigger` | Remove trigger |

**Workflows (commands/workflows.rs):**
| Command | Purpose |
|---------|---------|
| `list_workflows` | List workflows |
| `get_workflow` | Workflow detail with graph |
| `create_workflow` | Create with initial graph |
| `update_workflow` | Update graph (add/remove/connect nodes) |
| `delete_workflow` | Archive |
| `run_workflow` | Start execution |
| `get_workflow_run` | Run status with current node |
| `cancel_workflow_run` | Cancel running workflow |

### Frontend Pages

**Routines (pages/Routines.tsx):**
- Routine list with status badges (Active/Paused)
- Each row: title, assignee agent, schedule description, last run status, next run time
- Click → routine detail:
  - Overview: title, description, assignee, policies
  - Triggers: list of cron/manual triggers with enable/disable toggles
  - Variables: editable variable list with type and default value
  - Runs: paginated run history
- Manual trigger button with variable input dialog
- Concurrency/catch-up policy selectors (dropdowns)

**Workflow Builder (pages/WorkflowBuilder.tsx) — NEW:**
- Visual canvas with drag-and-drop node placement
- Library: evaluate React Flow (`@xyflow/react`) vs custom canvas
  - React Flow preferred: mature, handles panning/zooming/edge routing, extensible node types
- Node palette (left sidebar): draggable node types (AgentTask, Decision, Approval, Transform, Delay, Webhook)
- Canvas (center): nodes connected by edges, drag to rearrange
- Properties panel (right): edit selected node's configuration
- Toolbar: Save, Run, Validate (check all nodes connected, no orphans)
- Custom node components following ArchonOS design system:
  - 160×80px cards with icon, label, status dot
  - Edge handles on left/right sides
  - Selected state: accent border
- Graph stored as JSON: `{ nodes: [{id, type, position, data}], edges: [{id, source, target, label}] }`
- Workflow run visualization: highlight current node, show completed nodes in green, failed in red

### Verification
1. Create routine with cron "every 5 minutes" → trigger computes next_run_at
2. Wait for trigger → routine run created, issue assigned to agent
3. Manual trigger with variable overrides works
4. Concurrency policy: second trigger while active → coalesced (not duplicated)
5. Routine pause → no more triggers fire
6. Workflow builder: drag nodes onto canvas, connect with edges, save
7. Run workflow → nodes execute in sequence, state accumulates
8. Decision node branches correctly based on condition
9. Human approval node pauses workflow until approved
10. Workflow failure → run marked failed, error displayed
11. Routine and workflow appear in NavigationRail "Workflows" section

---

## Phase 5: Plugins, Local AI & System Integration

### Goal
Plugin ecosystem for extensibility, local AI model runtime for privacy and offline use, deep macOS system integration, and personal automation.

### Sub-phase 5A: Plugin System

**SQLite Tables (Migration V005a):**

```sql
CREATE TABLE plugins (
  id TEXT PRIMARY KEY NOT NULL,
  plugin_key TEXT NOT NULL UNIQUE,
  package_name TEXT,
  version TEXT,
  api_version INTEGER NOT NULL DEFAULT 1,
  categories TEXT DEFAULT '[]',          -- JSON
  manifest_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'installed',  -- installed, active, error, disabled
  install_order INTEGER,
  package_path TEXT,
  last_error TEXT,
  installed_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE plugin_config (
  id TEXT PRIMARY KEY NOT NULL,
  plugin_id TEXT NOT NULL UNIQUE REFERENCES plugins(id) ON DELETE CASCADE,
  config_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE plugin_state (
  id TEXT PRIMARY KEY NOT NULL,
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL,     -- instance, company, project, agent, issue, goal, run
  scope_id TEXT,
  namespace TEXT NOT NULL DEFAULT 'default',
  state_key TEXT NOT NULL,
  value_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(plugin_id, scope_kind, scope_id, namespace, state_key)
);

CREATE TABLE plugin_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  job_key TEXT NOT NULL,
  schedule TEXT,                -- cron expression
  status TEXT NOT NULL DEFAULT 'active',
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(plugin_id, job_key)
);

CREATE TABLE plugin_job_runs (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES plugin_jobs(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'scheduled',
  status TEXT NOT NULL DEFAULT 'pending',
  duration_ms INTEGER,
  error TEXT,
  logs TEXT DEFAULT '[]',
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Rust Service (services/plugin_host.rs):**
- Phase 5A: Plugins run as web workers in the Tauri webview (reuse `@paperclipai/plugin-sdk` worker protocol)
- JSON-RPC 2.0 communication (NDJSON over stdio → adapted for web worker postMessage)
- Plugin lifecycle state machine (from codebase map):
  ```
  [*] → installed → ready ↔ disabled
  installed → error (load failure)
  ready → error (runtime error)
  ready → upgrade_pending → ready (success) / error (failure)
  error → ready (retry/enable)
  any → uninstalled
  ```
- Crash recovery: exponential backoff on repeated failures
- Capability-based permissions: deny-by-default. Plugin manifest declares required capabilities (`PLUGIN_CAPABILITIES` from shared). ArchonOS prompts user to grant on install. `pluginCapabilityValidator` gates all operations.
- Plugin job scheduler: 30s tick (shared with routine scheduler), query `plugin_jobs` for due jobs. Overlap prevention (skip if already running).
- State management: scoped K-V storage via `plugin_state` table. Scopes: instance, company, project, agent, issue, goal, run.
- Event delivery: `PluginEventBus` with scoped pub/sub and wildcard patterns. Events: `issue.created`, `agent.run.completed`, etc.
- Plugin streams: SSE fan-out for real-time plugin UI updates
- Tool dispatch: `PluginToolRegistry` (dual-indexed by plugin + tool name) for agent tool calling
- Future (Phase 5B): WASM sandbox via `wasmtime` for system-access plugins

**Rust Commands (commands/plugins.rs):**
| Command | Purpose |
|---------|---------|
| `list_plugins` | List installed plugins |
| `install_plugin` | Install from path or registry |
| `uninstall_plugin` | Remove plugin + cleanup state |
| `get_plugin_config` | Get plugin config |
| `update_plugin_config` | Update plugin config |
| `enable_plugin` / `disable_plugin` | Toggle plugin status |
| `list_plugin_jobs` | Job definitions for plugin |
| `trigger_plugin_job` | Manual job trigger |

**Frontend (pages/PluginManager.tsx):**
- Installed plugins list with status (active/error/disabled)
- Install dialog (from local path initially, registry later)
- Plugin settings page per plugin
- Plugin job monitor

### Sub-phase 5B: Local AI Runtime

**Rust Service (services/local_ai.rs):**
- Model runtime using `candle` (Rust-native ML framework) or `llama-cpp-rs` (llama.cpp bindings)
- Model storage: `~/Library/Application Support/com.archonos.app/models/`
- Model registry: track downloaded models, sizes, capabilities
- Inference API: `generate(model_id, prompt, params) → stream of tokens`
- Streaming via Tauri events: `local-ai-token` events for real-time output
- GPU acceleration: Metal (macOS) via candle's Metal backend

**SQLite Tables (Migration V005b):**
```sql
CREATE TABLE local_models (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  family TEXT NOT NULL,           -- llama, mistral, phi, etc.
  file_path TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  quantization TEXT,              -- Q4_K_M, Q5_K_S, etc.
  context_length INTEGER,
  status TEXT NOT NULL DEFAULT 'ready',  -- downloading, ready, error
  download_progress REAL DEFAULT 0,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Rust Commands (commands/local_ai.rs):**
| Command | Purpose |
|---------|---------|
| `list_local_models` | List downloaded models |
| `download_model` | Download model file (with progress events) |
| `delete_model` | Remove model file + record |
| `generate_text` | Run inference (streams tokens via events) |
| `get_model_info` | Model metadata, benchmark results |
| `benchmark_model` | Run speed test, report tokens/sec |

**Frontend (pages/LocalAI.tsx):**
- Model library: available models to download, downloaded models
- Download progress with cancel
- Test prompt interface: input prompt → streaming output
- Model comparison: tokens/sec, memory usage
- Settings: default model, temperature, max tokens

### Sub-phase 5C: macOS System Integration & Automation

**Rust Service (services/automation.rs):**
- AppleScript/JXA bridge: execute AppleScript via `osascript` (Tauri shell plugin)
- Shortcuts integration: trigger macOS Shortcuts from ArchonOS
- File system watchers: `notify` crate for watching directories, trigger routines on file changes
- Calendar integration: read events via AppleScript bridge
- Clipboard monitoring: watch clipboard for agent-relevant content

**Rust Commands (commands/automation.rs):**
| Command | Purpose |
|---------|---------|
| `run_applescript` | Execute AppleScript string |
| `list_shortcuts` | List macOS Shortcuts |
| `run_shortcut` | Execute a macOS Shortcut by name |
| `watch_directory` | Start watching a directory for changes |
| `unwatch_directory` | Stop watching |
| `list_watchers` | Active file watchers |
| `get_system_info` | CPU, memory, disk usage |

**Additional macOS integrations:**
- `tauri-plugin-autostart` — already added in Phase 1
- `tauri-plugin-notification` — already added in Phase 1
- Spotlight integration: index agent names and issue titles for Spotlight search
- Menu bar quick actions: "New Issue" and "Wake Agent" from tray menu
- Touch Bar support (if applicable): show agent statuses, quick actions
- Drag-and-drop files from Finder into issue attachments

**Frontend (pages/Automation.tsx):**
- Automation rules list: "When [trigger] then [action]"
- Trigger types: File changed, Schedule, Shortcut, Manual
- Action types: Wake agent, Create issue, Run workflow, Run AppleScript
- Rule builder with dropdowns (not code)
- Active watchers list with pause/resume
- System shortcuts browser

### Sub-phase 5D: Offline Mode & Privacy

**Architecture:**
- All data already local-first (SQLite) — offline by default
- Network operations that fail: queue in `pending_operations` table, retry when online
- Network status detection: periodic ping or `navigator.onLine` + Tauri event
- Privacy controls per model/adapter:
  - "Local only" mode: never send data to external APIs
  - Data retention: auto-delete heartbeat run logs after N days
  - Audit log: track what data was sent where

**SQLite Tables:**
```sql
CREATE TABLE pending_operations (
  id TEXT PRIMARY KEY NOT NULL,
  operation_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Phase 5 Verification
1. Install plugin from local path → appears in plugin manager
2. Plugin job runs on schedule → logs captured
3. Plugin state persists across app restarts
4. Download a local model → progress bar → model ready
5. Generate text with local model → tokens stream in real-time
6. GPU acceleration detected and used (Metal on macOS)
7. AppleScript execution works (e.g., "tell application Finder to activate")
8. File watcher triggers routine on directory change
9. Automation rule: "When file created in ~/Downloads → Create issue" works
10. Offline: disconnect network → app continues to work with local data
11. Pending operations queue → syncs when reconnected

---

## Risks & Mitigations (All Phases)

| Risk | Phase | Likelihood | Impact | Mitigation |
|------|-------|-----------|--------|------------|
| Tauri v2 API breaks | All | Medium | High | Pin exact version. Don't use unstable features |
| Frameless window quirks | 1 | Medium | Medium | Fallback: `decorations: true` |
| SQLite vs PostgreSQL gaps | 2-3 | Medium | Medium | JSON columns for arrays. FTS5 for search. Test each table |
| Adapter assumes Express context | 2 | Medium | Medium | Test each adapter. Wrap Tauri shell plugin to match spawn expectations |
| React Flow bundle size | 4 | Low | Low | Code-split workflow builder. Lazy load |
| candle/llama.cpp Metal support | 5 | Medium | High | Fallback: CPU-only inference. Document performance expectations |
| AppleScript sandboxing | 5 | Medium | Medium | Test in both sandboxed and unsandboxed builds. Document required permissions |
| Plugin security | 5 | Medium | High | Capability-based permissions. User consent. WASM sandbox for untrusted plugins |
| Large model downloads | 5 | Low | Low | Background downloads with progress. Resume support |
| Compile times (Rust + candle) | 5 | High | Low | Feature flags — only compile AI runtime when needed |

---

## Phase Dependencies & Build Order

```
Phase 1 (Shell) ─────────────────────────────────────────→ Phase 2 (Agents)
                                                                │
                                                                ├─→ Phase 3 (Projects/Issues/Goals/Costs)
                                                                │        │
                                                                │        ├─→ Phase 4 (Routines/Workflows)
                                                                │        │
                                                                │        └─→ Phase 5A (Plugins)
                                                                │
                                                                └─→ Phase 5B (Local AI) — independent of 3/4

Phase 5C (Automation) — depends on Phase 2 (agents to wake) + Phase 3 (issues to create)
Phase 5D (Offline) — depends on Phase 3 (data to sync)
```

**Critical path:** Phase 1 → 2 → 3 → 4 (each builds on the previous).
**Parallelizable:** Phase 5B (Local AI) can start alongside Phase 3. Phase 5A (Plugins) can start alongside Phase 4.

## Packaging & Distribution

- Phase 1: `pnpm tauri build` → unsigned `.app` + `.dmg`
- Phase 3+: Apple Developer account for code signing + notarization
- Future: GitHub Actions for automated macOS builds (requires macOS runner + signing secrets)
- Auto-update: `tauri-plugin-updater` for in-app updates (Phase 3+)

---

## Critical Files to Reference

| File | Purpose | Used in |
|------|---------|---------|
| `ui/src/components/Layout.tsx` | 3-column layout architecture | Phase 1 |
| `ui/src/api/client.ts` | API client error shape | Phase 1 |
| `ui/src/index.css` | oklch design tokens | Phase 1 |
| `ui/src/components/ui/*` | 11 Radix primitives | Phase 1 |
| `ui/src/lib/utils.ts` | `cn()` utility | Phase 1 |
| `ui/src/context/ThemeContext.tsx` | Theme system | Phase 1 |
| `ui/src/components/CommandPalette.tsx` | cmdk palette | Phase 1 |
| `ui/src/components/CompanyRail.tsx` | Navigation rail pattern | Phase 1 |
| `packages/shared/src/index.ts` | Domain types | Phase 2+ |
| `server/src/routes/agents.ts` | 30+ agent endpoints | Phase 2 |
| `server/src/services/heartbeat.ts` | Heartbeat scheduling | Phase 2 |
| `packages/db/src/schema/agents.ts` | Agent table schema | Phase 2 |
| `packages/adapters/claude-local/` | Adapter implementation | Phase 2 |
| `ui/src/pages/Agents.tsx` | Agent list UI | Phase 2 |
| `ui/src/pages/AgentDetail.tsx` | Agent detail UI | Phase 2 |
| `ui/src/pages/OrgChart.tsx` | Org chart rendering | Phase 2 |
| `server/src/routes/issues.ts` | 41 issue endpoints | Phase 3 |
| `packages/db/src/schema/issues.ts` | Issue table (49 columns) | Phase 3 |
| `server/src/routes/costs.ts` | 19 cost endpoints | Phase 3 |
| `server/src/routes/routines.ts` | 11 routine endpoints | Phase 4 |
| `packages/db/src/schema/routines.ts` | Routine + trigger schema | Phase 4 |
| `server/src/services/routines.ts` | Routine scheduler + cron | Phase 4 |
| `packages/plugins/sdk/src/protocol.ts` | Plugin JSON-RPC protocol | Phase 5A |
| `packages/plugins/sdk/src/types.ts` | Plugin types + manifest | Phase 5A |
| `server/src/realtime/live-events-ws.ts` | Live events architecture | Phase 2 |
| `ui/src/context/LiveUpdatesProvider.tsx` | Live event consumption | Phase 2 |
| `server/src/services/issue-execution-policy.ts` | Issue execution state machine | Phase 3 |
| `server/src/services/company-portability.ts` | Company import/export (38k, largest service) | Phase 3 |
| `ui/src/components/IssueChatThread.tsx` | AI chat thread (17k, @assistant-ui/react) | Phase 3 |
| `ui/src/components/OnboardingWizard.tsx` | 4-step first-run wizard (11k) | Phase 1 |
| `ui/src/components/AgentConfigForm.tsx` | Dual-mode agent config form (12k) | Phase 2 |
| `ui/src/components/MarkdownEditor.tsx` | Rich markdown with @-mention and /slash (8k) | Phase 3 |
| `ui/src/components/IssuesList.tsx` | Filterable issues table + kanban (8k) | Phase 3 |
| `server/src/services/workspace-runtime.ts` | Local runtime services for agents (18k) | Phase 2 |
| `server/src/services/execution-workspaces.ts` | Git worktree provisioning (6k) | Phase 2 |
| `packages/adapter-utils/` | Shared adapter foundation (runChildProcess, buildPaperclipEnv) | Phase 2 |
| `docs/CODEBASE_MAP.md` | Full architecture reference with service dependency graph | All |
| `pnpm-workspace.yaml` | Workspace config | Phase 1 |
