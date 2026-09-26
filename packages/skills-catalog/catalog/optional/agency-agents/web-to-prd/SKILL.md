---
name: "web-to-prd"
description: "Scan a live web app with Playwright, extract all features, generate PRD/epics/stories with priorities and dependencies, export to Notion. Checks required MCP servers before starting."
allowed_tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - WebSearch
  - mcp__playwright__browser_navigate
  - mcp__playwright__browser_click
  - mcp__playwright__browser_snapshot
  - mcp__playwright__browser_take_screenshot
  - mcp__playwright__browser_type
  - mcp__playwright__browser_tabs
  - mcp__playwright__browser_close
  - mcp__playwright__browser_hover
  - mcp__playwright__browser_fill_form
  - mcp__playwright__browser_select_option
  - mcp__playwright__browser_press_key
  - mcp__playwright__browser_navigate_back
  - mcp__playwright__browser_wait_for
  - mcp__playwright__browser_evaluate
  - mcp__playwright__browser_resize
  - mcp__playwright__browser_console_messages
  - mcp__playwright__browser_network_requests
  - mcp__playwright__browser_drag
  - mcp__playwright__browser_file_upload
  - mcp__playwright__browser_handle_dialog
  - mcp__playwright__browser_run_code
key: "paperclipai/optional/agency-agents/web-to-prd"
recommendedForRoles:
  - "designer"
  - "product"
  - "researcher"
tags:
  - "agency-agents"
  - "designer"
  - "product"
  - "researcher"
  - "web"
  - "prd"
defaultInstall: false
---
# Web-to-PRD Skill

Scan a live web app. Extract every feature. Turn it into a structured PRD with epics, stories, and tasks. Push it all to Notion.

## When to Use

- Reverse-engineer a competitor's product
- Document an existing app you're taking over
- Create a PRD from a live product (yours or someone else's)
- Build a feature backlog from scratch by looking at what's already built

## What This Skill Does

1. **Checks prerequisites** — makes sure Playwright MCP and Notion MCP are connected
2. **Crawls the web app** — navigates page by page, reads UI elements
3. **Extracts features** — groups what it finds into feature areas
4. **Generates PM artifacts** — PRD, epics, stories, tasks with priorities and dependencies
5. **Exports to Notion** — creates linked databases, populates everything

## Prerequisites

This skill needs 2 MCP servers. The command checks both before starting.

### 1. Playwright MCP (browser control)

Codex uses Playwright to open a real browser, navigate pages, and read content.

#### Browser modes

| Mode | Install command | What it does |
|------|----------------|-------------|
| **Persistent profile (default)** | See setup below | Lightweight profile at `~/.playwright-profile`. Login once, remembered. Chrome stays open. No extensions bloat. |
| CDP (advanced) | `--cdp-endpoint='http://localhost:9222'` | Connects to running Chrome. Has your logins but also loads all extensions (can be slow). |
| Chrome profile (heavy) | `--user-data-dir="[Chrome path]" --browser=chrome` | Uses real Chrome profile. Has logins but loads ALL extensions — often causes timeouts. Not recommended. |
| Clean session | no extra flags | Fresh browser each time. No saved state. Public sites only. |

#### Default setup: Persistent profile (auto-installed by the command)

The `/spartan:web-to-prd` command handles installation itself. Uses a lightweight separate profile at `~/.playwright-profile` — no extensions, no bloat, fast startup.

**What the command does internally:**
```bash
Codex mcp remove playwright 2>/dev/null || true
Codex mcp add playwright -- npx @playwright/mcp@latest --user-data-dir="$HOME/.playwright-profile" --browser=chrome
```

**First run on a login-protected site:** Playwright opens Chrome with a clean profile. User logs in manually. Cookies are saved to `~/.playwright-profile`. Next runs are already logged in.

**Why not the real Chrome profile?** Real Chrome profiles load ALL extensions (AdBlock, LastPass, password managers, etc.). These add latency, block requests, and often cause Playwright to timeout or hang. A separate profile is faster and more reliable.

**Chrome can stay open.** Since we use a separate profile, there's no conflict.

#### Switching modes

To change mode, remove and re-add:
```bash
Codex mcp remove playwright
Codex mcp add playwright -- npx @playwright/mcp@latest [flags]
```

#### All Playwright MCP flags

| Flag | What it does |
|------|-------------|
| `--cdp-endpoint="http://localhost:9222"` | Connect to running Chrome via CDP |
| `--user-data-dir="/path"` | Persistent browser profile (keeps cookies) |
| `--storage-state="/path/to/state.json"` | Load saved cookies from file |
| `--isolated` | Fresh session, no persistent data |
| `--browser=chrome` | Use real Chrome instead of Chromium |
| `--headless` | No visible browser window |

All flags also work as env vars with `PLAYWRIGHT_MCP_` prefix (e.g., `PLAYWRIGHT_MCP_CDP_ENDPOINT`).

**How to verify Playwright MCP is installed:**
```bash
Codex mcp list | grep -i playwright
```

**What it gives you:** `browser_navigate`, `browser_click`, `browser_snapshot`, `browser_type`, `browser_tab_list` and more.

### 2. Notion MCP (export destination)

Codex uses Notion MCP to create databases, pages, and views in your workspace.

**How to install:**
The Notion MCP is available as a Codex.ai integration. Enable it from:
- Codex settings > MCP servers
- Or Codex Desktop > Settings > Integrations > Notion

**How to verify:**
```bash
Codex mcp list | grep -i notion
```

**What it gives you:** `notion-create-database`, `notion-create-pages`, `notion-create-view`, `notion-search`, `notion-update-page`.

### Optional: Firecrawl MCP (faster crawling)

If the user has Firecrawl, use it instead of Playwright for the initial crawl. It's faster but costs money.

```bash
Codex mcp add firecrawl -- npx firecrawl-mcp
```

Firecrawl is optional. Playwright alone handles everything.

---

## Prerequisite Check Logic

Run this check at the start.

**IMPORTANT: `Codex mcp add/remove` does NOT make tools available mid-session.** MCP tools only load when Codex starts. Never try to install or reconfigure MCP servers during a running session — it won't work and wastes time.

```
CHECK 1: Playwright MCP
  A) Try calling any Playwright tool (e.g., browser_snapshot or browser_navigate)

  If tool works → check the config:
     Read .Codex.json for playwright args
     If --user-data-dir points to ~/.playwright-profile → good, proceed
     If --user-data-dir points to real Chrome profile → warn user (extensions cause timeouts)
     If no --user-data-dir (clean mode) → OK for public sites
     If --cdp-endpoint → good, proceed

  If tool NOT found → Playwright MCP is not loaded. Show this message and STOP:

     "Playwright MCP is not available. I need it to open a browser.

     Run this in your terminal (outside Codex):
       Codex mcp add playwright -- npx @playwright/mcp@latest --user-data-dir=$HOME/.playwright-profile --browser=chrome

     Then restart Codex and run /spartan:web-to-prd again."

  NEVER run `Codex mcp add` or `Codex mcp remove` yourself during the session.
  It changes the config file but won't load the tools until restart.

CHECK 2: Notion MCP (OPTIONAL — not a blocker)
  Try calling notion-search with a simple query
  If found → great, will export to Notion at the end
  If not found → note it, will save PRD locally instead. Continue with crawl.

Playwright OK → proceed to crawl
```

**Notion is optional.** The PRD is always saved locally. Notion export is a bonus step at the end.

---

## Crawl Strategy

### Step 0: Clean up stale lock files (before every run)

Stale lock files from previous browser sessions can cause "Opening in existing browser session" errors. **Only remove lock files — never kill processes:**

```bash
rm -f "$HOME/.playwright-profile/SingletonLock" \
      "$HOME/.playwright-profile/SingletonCookie" \
      "$HOME/.playwright-profile/SingletonSocket" 2>/dev/null
echo "Browser cleanup done"
```

**WARNING:** Do NOT run `pkill -f "playwright-profile"` — it kills the Playwright MCP server process too, disconnecting all browser tools mid-session.

If navigate still fails after cleanup → retry once after 2 seconds. If still fails → user needs to restart Codex.

### Step 1: Login FIRST (mandatory before crawling)

**Never start crawling without confirming access. Login is Step 1, not an afterthought.**

1. Navigate to the target URL
2. Take a snapshot — check for login signals (form fields, "Sign in" text, `/login` URL)
3. **If login page:**
   - STOP. Tell user: "Login page detected. Please log in in the browser window. Tell me when done."
   - Wait for user confirmation
   - Take snapshot to verify — still login page? Ask again. See dashboard? Proceed.
   - **Repeat until logged in.** Do NOT start crawling from a login page.
4. **If already logged in** (or public site):
   - Show the user what sections are visible
   - Ask: "Does this look like full access? Any sections I'm missing?"
   - Wait for confirmation before crawling

**Session expiry during crawl:** If redirected to login mid-crawl → STOP, tell user to re-login in the browser, wait for confirmation, then continue where you left off.

**Security rules:**
- Never use `browser_type` to enter passwords — user types directly in the browser
- Never ask for credentials in chat
- Never screenshot login pages
- SSO/OAuth popups work normally — just wait for user to complete

**Cookies:** With persistent profile (`~/.playwright-profile`), logins are saved. Next run on the same site = already logged in.

### Step 2: Two-pass crawl

**Pass 1 — Map all pages (breadth-first):**
Visit every nav link, take a screenshot, note the page type, go back. Build a complete sitemap. Don't explore features deeply yet. Go back to home between sections. Show the sitemap to user and ask if anything is missing.

**Pass 2 — Deep exploration (exhaust every feature):**
Go through each page from the sitemap. On each page: try EVERY interactive element until there's nothing left to try. Click a button → opens a modal? → what's in the modal? → has a form? → what fields? → has a submit button? → what happens after submit? → follow every path until you hit a dead end or a page you already explored. Only move to next page when you've exhausted all interactions on this page. The goal is to discover features that are 2-3 levels deep — hidden behind tabs, modals, sub-pages, or conditional UI.

### Screenshots (mandatory)

Take a screenshot of every page and every important UI state. Save to `.planning/web-to-prd/screenshots/` with names like `01-homepage.png`, `02-dashboard.png`, `07-create-modal.png`. Include screenshot references in each Epic. Never screenshot login pages.

### For SPAs (single page apps)

SPAs don't have traditional page URLs. Use this approach:
1. Start at the root URL
2. Read the navigation/sidebar for all sections
3. Click each section, wait for content to load
4. Take snapshot after each navigation
5. Track visited states by URL hash or path changes

### Crawl depth limits

| App size | Max pages | Estimated time |
|----------|-----------|----------------|
| Small (< 10 pages) | All pages | 2-5 min |
| Medium (10-50 pages) | All pages | 5-15 min |
| Large (50+ pages) | Top 50, then ask user | 15+ min |

After every 10 pages, show progress:
> "Scanned 10/~25 pages. Found 3 feature areas so far. Continue?"

### Coverage Check (mandatory before generating PRD)

After crawling, show a coverage report: pages visited, screenshots taken, buttons clicked, modals found, forms found, tabs explored, filters tested. List all nav sections and mark which were explored vs skipped.

**Fail if:** any nav section not explored, fewer screenshots than pages, zero modals on a page with buttons (means you didn't click them), any section with only 1 interaction (you only looked, didn't try).

Ask user to confirm coverage before proceeding to PRD generation.

---

## Feature Extraction

### What to extract from each page

For every page visited, capture:

```yaml
page:
  url: "/dashboard"
  title: "Dashboard"
  type: dashboard | list | detail | form | settings | landing | auth | empty
  features:
    - name: "Revenue Chart"
      type: data-display | form | action | navigation | filter | notification
      description: "Line chart showing monthly revenue with date range picker"
      ui_elements:
        - chart (line, with tooltips)
        - date range picker
        - export button
      interactions:
        - hover shows tooltip with exact value
        - date range filters the data
        - export downloads CSV
    - name: "Quick Actions Bar"
      type: action
      description: "Row of shortcut buttons: New Invoice, New Client, Reports"
      interactions:
        - each button navigates to respective page
```

### Feature grouping rules

After crawling, group features into **feature areas** (these become Epics):

1. **By navigation section** — sidebar/navbar sections are natural groupings
2. **By user goal** — what is the user trying to do?
3. **By data domain** — features that touch the same data belong together

Example groupings:
```
Epic: User Management
  - User list with search/filter
  - User profile page
  - User invite flow
  - Role assignment
  - User deactivation

Epic: Billing & Payments
  - Invoice list
  - Create invoice form
  - Payment tracking
  - Subscription management
  - Billing settings
```

### Priority assignment

Assign priority based on visibility and complexity:

| Priority | Criteria |
|----------|----------|
| P0 - Must have | Core user flow, app doesn't work without it |
| P1 - Should have | Important but app is usable without it |
| P2 - Nice to have | Enhancement, polish, edge case handling |
| P3 - Future | Advanced feature, nice but not needed now |

**Heuristics:**
- Main navigation items → P0 or P1
- Settings/config pages → P1 or P2
- Empty states, onboarding → P2
- Social features, sharing → P2 or P3

### Dependency mapping

Map dependencies between features:

```
Epic: Authentication (must build first)
  → Epic: User Management (needs auth)
    → Epic: Team Management (needs users)
      → Epic: Permissions (needs teams)

Epic: Product Catalog (independent)
  → Epic: Shopping Cart (needs products)
    → Epic: Checkout (needs cart)
      → Epic: Order Management (needs checkout)
```

Rules for dependencies:
- CRUD operations: Create before Read/List before Update before Delete
- Auth is always first
- Data display depends on data input
- Settings depend on the feature they configure

---

## PRD Generation

### Structure

Generate a PRD with 8 sections. **Each Epic is a mini-PRD** — a developer reads one Epic and knows exactly what to build.

```
1. TL;DR              — 2 sentences, what this app does
2. Goals              — Business goals, user goals, non-goals
3. User Stories        — Grouped by persona/role
4. Epics (mini-PRDs)  — THE MAIN SECTION. Each epic has full detail (see below)
5. User Flows         — End-to-end flows connecting stories across epics
6. Narrative          — 200-word story from user's POV
7. Build Roadmap      — Phased plan with dependency graph
8. Open Questions     — Things that need human input
```

**Section 4 (Epics) is the core.** Epics are ordered by build priority (Epic 1 = build first).

**Each Epic is a FULL PRD with 6 sections:**

```
Epic N: [Name]
├── 1. TL;DR — what this epic solves, who it's for
├── 2. Goals — business goals, user goals, non-goals
├── 3. User Stories — As a [user], I want...
├── 4. Functional Requirements — every feature with screenshots, UI detail, priority
├── 5. User Experience — entry point, flow (step by step), edge cases, design notes
└── 6. Narrative — 100-word user story for this epic
```

**No epic can skip any section.** Every epic gets all 6 sections. This is what makes the PRD actionable — a developer reads one Epic page and knows exactly what to build.

**Screenshots are embedded in Section 4** next to the features they show. Not at the end, not as links — inline with the content. In the markdown PRD, use `![Feature name](screenshots/NN-name.png)` for every feature that has a screenshot. The PRD must be self-contained — anyone opening the file sees screenshots right next to the features.

**Be as detailed as possible.** Describe every button, every form field, every table column, every filter option.

**Try EVERY feature.** Click every menu, open every modal, test every filter. Missing features = useless PRD.

See the command file (`web-to-prd.md`) for the full template with examples.

---

## Notion Export

### Database Structure

Create a parent page with one sub-page per Epic:

```
Parent page: "[App Name] — PRD"
├── PRD overview (sections 1-3, 5-8)
├── Epic 1: [Name] (full page with screenshots, features, acceptance criteria)
├── Epic 2: [Name] (full page with screenshots, features, acceptance criteria)
├── ...
└── Optional: Epics overview database (for filtering/sorting, links to pages)
```

**Each Epic = a full Notion page**, not a database row with a Description field. Include:
- Full content from the PRD Section 4 format
- Screenshots embedded directly in the page (visible, not links)
- Every feature detail: user story, UI description, step-by-step, acceptance criteria

**Screenshots must be uploaded to Notion**, not just saved locally. Place them next to the features they document.

### Export steps

1. **Ask where to put it:**
   > "Where should I create the backlog in Notion?
   > A) Create a new page in your workspace root
   > B) Add it under an existing page (I'll search for it)
   > C) Just generate the PRD locally, don't push to Notion"

2. **Create parent page** with the PRD content
3. **Create Epics database** with all epics
4. **Create Stories database** linked to Epics
5. **Create Tasks database** linked to Stories
6. **Create views:**
   - Kanban view (by Status) for Stories
   - Timeline view (by Phase) for Epics
   - Table view (default) for Tasks

### If Notion MCP is not available

Save everything locally:
```
.planning/web-to-prd/
├── prd.md                    # Full PRD document (screenshots embedded as ![name](screenshots/NN.png))
├── epics.md                  # All epics with stories
├── dependency-graph.md       # Visual dependency map
└── screenshots/              # Page screenshots
```

**Screenshots in the markdown are mandatory.** Every feature that has a screenshot must embed it inline using `![Feature name](screenshots/NN-name.png)`. Paths are relative to the PRD file.

User can import to Notion manually later.

---

## Rules

1. **Always check prerequisites first.** Don't start crawling without confirming both MCP servers.
2. **Login before crawling.** Never generate a PRD from a login page or public-only view. If the app has login, handle it first. Verify you see the full app before starting.
3. **Confirm access level.** After login, show the user what sections are visible and ask if anything is missing. A PRD from a limited view is useless.
4. **Handle session expiry.** If redirected to login mid-crawl, STOP and ask user to re-login. Don't crawl from a login page.
5. **Show progress during crawl.** Every 10 pages or every major section, update the user.
3. **Don't guess features you can't see.** Only document what's visible in the UI. Mark assumptions clearly.
4. **Ask before clicking destructive actions.** If you see "Delete" or "Remove" buttons, don't click them during crawl.
5. **Handle errors gracefully.** If a page fails to load, note it and move on. Don't stop the whole crawl.
6. **Respect rate limits.** Add 1-2 second delays between page navigations to avoid being blocked.
7. **Screenshots are mandatory.** Take them for every page and embed them in the markdown PRD using `![name](path)` syntax.
8. **Login is the user's job.** Never store or ask for production credentials. Use headed mode for manual login.
9. **Local save is always available.** Even if Notion export fails, the PRD is saved locally.
10. **One app per run.** Don't crawl multiple domains in a single session.
11. **NEVER point `--user-data-dir` to the real Chrome profile directory** (e.g., `~/Library/Application Support/Google/Chrome` on Mac, `~/.config/google-chrome` on Linux). This can corrupt Chrome profiles, delete saved logins, and break the user's browser. Always use a separate directory like `~/.playwright-profile`.
