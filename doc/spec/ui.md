# Paperclip UI Spec

Status: Draft
Date: 2026-02-17

## 1. Design Philosophy

Paperclip's UI is a professional-grade control plane, not a toy dashboard. It should feel like the kind of tool you live in all day — fast, keyboard-driven, information-dense without being cluttered, dark-themed by default. Every pixel should earn its place.

Design principles:

- **Dense but scannable.** Show maximum information without requiring clicks to reveal it. Use whitespace to separate, not to pad.
- **Keyboard-first.** Global shortcuts for search (Cmd+K), new issue (C), navigation. Power users should rarely touch the mouse.
- **Contextual, not modal.** Inline editing over dialog boxes. Dropdowns over page navigations. The user's mental context should never be broken unnecessarily.
- **Dark theme default.** Neutral grays, not pure black. Accent colors used sparingly for status and priority. Text is the primary visual element.

### Color System

- **Background:** `hsl(220, 13%, 10%)` (dark charcoal, not pure black)
- **Surface/Card:** `hsl(220, 13%, 13%)`
- **Border:** `hsl(220, 10%, 18%)`
- **Text primary:** `hsl(220, 10%, 90%)`
- **Text secondary:** `hsl(220, 10%, 55%)`
- **Accent (interactive):** `hsl(220, 80%, 60%)` (muted blue)

Status colors (consistent across all entities):
- **Backlog:** gray `hsl(220, 10%, 45%)`
- **Todo:** gray-blue `hsl(220, 20%, 55%)`
- **In Progress:** yellow `hsl(45, 90%, 55%)`
- **In Review:** violet `hsl(270, 60%, 60%)`
- **Done:** green `hsl(140, 60%, 50%)`
- **Cancelled:** gray `hsl(220, 10%, 40%)`
- **Blocked:** amber `hsl(25, 90%, 55%)`

Priority indicators:
- **Critical:** red circle, filled
- **High:** orange circle, half-filled
- **Medium:** yellow circle, outline
- **Low:** gray circle, outline, dashed

### Typography

- **Font:** System font stack (Inter if loaded, else `-apple-system, BlinkMacSystemFont, 'Segoe UI'`)
- **Body:** 13px / 1.5 line-height
- **Labels/metadata:** 11px / uppercase tracking
- **Headings:** 14-18px / semi-bold, never all-caps

### Icons

Use `lucide-react` throughout. Every sidebar item, every status indicator, every action button should have an icon. Icons are 16px in nav, 14px inline.

---

## 2. Application Shell

The app is a three-zone layout:

```
┌──────────┬────────────────────────────────────────────────┐
│          │  Breadcrumb bar                                │
│ Sidebar  ├──────────────────────────┬─────────────────────┤
│ (240px)  │  Main content            │  Properties panel   │
│          │  (flex-1)                │  (320px, optional)  │
│          │                          │                     │
└──────────┴──────────────────────────┴─────────────────────┘
```

- **Sidebar:** Fixed left, 240px. Collapsible to icon-only (48px) via toggle or keyboard shortcut.
- **Breadcrumb bar:** Spans the full width above main+properties. Shows navigation path, entity actions, and view controls.
- **Main content:** Scrollable. Contains the primary view (list, detail, chart, etc).
- **Properties panel:** Right side, 320px. Shown on detail views (issue detail, project detail, agent detail). Hidden on list views and dashboard. Resizable.

The properties panel slides in when you click into a detail view and slides out when you go back to a list. It is NOT a sidebar — it's contextual to the selected entity.

---

## 3. Sidebar

The sidebar is the primary navigation. It is grouped into logical sections with collapsible headers.

### 3.1 Company Header

Top of sidebar. Always visible.

```
┌─────────────────────────┐
│ [icon] Acme Corp      ▼ │  ← Company switcher dropdown
├─────────────────────────┤
│ [🔍]  [✏️]              │  ← Search + New Issue
└─────────────────────────┘
```

**Company switcher** is a dropdown button that occupies the full width of the sidebar header. It shows:
- Company icon (first letter avatar with company color, or uploaded icon)
- Company name (truncated with ellipsis if long)
- Chevron-down icon

Clicking opens a dropdown with:
- List of all companies (with status dot: green=active, yellow=paused, gray=archived)
- Search field at top of dropdown (for users with many companies)
- Divider
- `+ Create company` action at the bottom

Below the company name, a row of icon buttons:
- **Search** (magnifying glass icon) — opens Cmd+K search modal
- **New Issue** (pencil/square-pen icon) — opens new issue modal in the current company context

### 3.2 Personal Section

No section header — these are always at the top, below the company header.

```
  Inbox                    3
  My Issues
```

- **Inbox** — items requiring the board operator's attention. Badge count on the right. Includes: pending approvals, stale tasks, budget alerts, failed heartbeats. The number is the total unread/unresolved count.
- **My Issues** — issues created by or assigned to the board operator.

### 3.3 Work Section

Section header: **Work** (collapsible, with a chevron toggle)

```
  Work                     ▼
    Issues
    Projects
    Goals
    Views
```

- **Issues** — main task list for the selected company. This is the workhorse view.
- **Projects** — project list. Projects group issues and link to goals.
- **Goals** — company goal hierarchy.
- **Views** — saved filter/sort configurations (e.g., "Critical bugs", "Unassigned tasks", "CEO's tasks"). Users can create, name, and pin custom views here.

### 3.4 Company Section

Section header: **Company** (collapsible)

```
  Company                  ▼
    Dashboard
    Briefings
    Org Chart
    Agents
    Costs
    Activity
```

- **Dashboard** — company health overview: agent statuses, task velocity, cost burn, pending approvals count.
- **Briefings** — executive board, durable results library, planning library, and shared record detail pages.
- **Org Chart** — interactive tree visualization of the agent reporting hierarchy.
- **Agents** — flat list of all agents with status, role, last heartbeat, spend.
- **Costs** — cost dashboard with breakdowns by agent, project, model, time.
- **Activity** — audit log of all system events.

Note: Approvals do not have a top-level sidebar entry. They are surfaced through the **Inbox** (primary interaction point), **Dashboard** (pending count metric), and **inline on entity pages** (e.g., an agent detail page shows the approval that authorized its hire). The `/approvals` route still exists and is reachable via "See all approvals" links in Inbox and Dashboard, but it is not in the sidebar navigation.

### 3.5 Section Behavior

- Each section header is clickable to collapse/expand its children.
- Collapsed state persists in localStorage.
- Active nav item is highlighted with a left-border accent and background tint.
- Hovering a nav item shows a subtle background highlight.
- Badge counts are right-aligned, rendered as small pills (e.g., `3` in a rounded rect).
- Icons are 16px, left-aligned, with 8px gap to label text.

### 3.6 Sidebar Icons

Each nav item has a distinctive icon (lucide-react):

| Item | Icon |
|------|------|
| Inbox | `Inbox` |
| My Issues | `CircleUser` |
| Issues | `CircleDot` |
| Projects | `Hexagon` |
| Goals | `Target` |
| Views | `LayoutList` |
| Dashboard | `LayoutDashboard` |
| Briefings | `FileText` |
| Org Chart | `GitBranch` |
| Agents | `Bot` |
| Costs | `DollarSign` |
| Activity | `History` |

---

## 4. Breadcrumb Bar

The breadcrumb bar sits above the main content and properties panel. It serves as both navigation and context indicator.

### 4.1 Structure

```
┌─────────────────────────────────────────────────────────────────────┐
│ Projects › Paperclip › Issues › CLIP-42  [⭐] [···]     [🔔] [⬜] │
└─────────────────────────────────────────────────────────────────────┘
```

**Left side:**
- Breadcrumb segments, separated by `›` chevrons.
- Each segment is clickable to navigate to that level.
- Current segment is non-clickable, slightly bolder text.
- Star icon to favorite/pin the current entity.
- Three-dot menu for entity actions (delete, archive, duplicate, copy link, etc.)

**Right side:**
- Notification bell (if in a detail view — subscribe to changes on this entity)
- Panel toggle (show/hide the right properties panel)

### 4.2 View-Specific Tabs

On certain detail pages, the breadcrumb bar also contains a tab row below the breadcrumbs:

**Project detail:**
```
  Overview    Updates    Issues    Settings
```

**Agent detail:**
```
  Overview    Heartbeats    Issues    Costs
```

Tabs are rendered as pill-shaped buttons. Active tab has a subtle background fill.

---

## 5. Issues (Task Management)

Issues are the core work unit. This section details the full issue experience.

### 5.1 Issue List View

The issue list is the default view when clicking "Issues" in the sidebar.

**Layout:**
```
┌─────────────────────────────────────────────────────────────────┐
│ [All Issues] [Active] [Backlog]  [⚙ Settings]    [≡ Filter]  [Display ▼] │
├─────────────────────────────────────────────────────────────────┤
│ ▼ Todo                                                3    [+] │
│ ☐ --- CLIP-5  ○ Implement user auth          @CTO    Feb 16  │
│ ☐ --- CLIP-3  ○ Set up CI pipeline           @DevOps Feb 16  │
│ ☐ --- CLIP-8  ○ Write API documentation      @Writer Feb 17  │
│                                                                 │
│ ▼ In Progress                                         2    [+] │
│ ☐ !!! CLIP-1  ◐ Build landing page           @FE     Feb 15  │
│ ☐ --- CLIP-4  ◐ Database schema design       @CTO    Feb 14  │
│                                                                 │
│ ▼ Backlog                                             5    [+] │
│ ☐ --- CLIP-9  ◌ Research competitors                  Feb 17  │
│ ...                                                             │
└─────────────────────────────────────────────────────────────────┘
```

**Top toolbar:**
- **Status tabs:** `All Issues`, `Active` (todo + in_progress + in_review + blocked), `Backlog`. Each tab shows a status icon and count. Active tab is filled, others outlined.
- **Settings gear:** Configure issue display defaults, custom fields.
- **Filter button:** Opens a filter bar below the toolbar.
- **Display dropdown:** Toggle between grouping modes (by status, by priority, by assignee, by project, none) and layout modes (list, board/kanban).

**Grouping:**
- Issues are grouped by status by default (matching the reference screenshots).
- Each group header shows: collapse chevron, status icon, status name, count, and a `+` button to create a new issue in that status.
- Groups are collapsible. Collapsed groups show just the header with count.

**Issue rows:**
Each row contains, left to right:
1. **Checkbox** — for bulk selection. Hidden by default, appears on hover (left of priority).
2. **Priority indicator** — icon representing critical/high/medium/low (see Color System above). Always visible.
3. **Issue key** — e.g., `CLIP-5`. Monospace, muted color. The prefix is derived from the project (or company if no project).
4. **Status circle** — clickable to open status change dropdown (same as reference screenshot). The circle's fill/color reflects current status.
5. **Title** — primary text, truncated with ellipsis if too long.
6. **Assignee** — avatar (agent icon) + agent name, right-aligned. If unassigned, shows a dashed circle placeholder.
7. **Date** — creation date or target date, muted text, far right.

**Row interactions:**
- Click row → navigate to issue detail view.
- Click status circle → opens inline status dropdown (Backlog, Todo, In Progress, In Review, Done, Cancelled) with keyboard numbers as shortcuts (1-6).
- Click checkbox → selects for bulk actions. When any checkbox is selected, a bulk action bar appears at the bottom of the list.
- Hover → shows checkbox, and row gets subtle background highlight.
- Right-click → context menu (same actions as three-dot menu).

**Bulk action bar:**
When one or more issues are selected, a floating bar appears at the bottom:
```
┌─────────────────────────────────────────────────────────┐
│  3 selected    [Status ▼] [Priority ▼] [Assignee ▼] [Project ▼]  [🗑 Delete]  [✕ Cancel] │
└─────────────────────────────────────────────────────────┘
```

### 5.2 Issue Filter Bar

Clicking "Filter" reveals a filter bar below the toolbar:

```
┌─────────────────────────────────────────────────────────┐
│ [+ Add filter]  Status is Todo, In Progress  [×]        │
│                 Priority is Critical, High    [×]        │
│                 Assignee is CTO-Agent         [×]        │
└─────────────────────────────────────────────────────────┘
```

- Each filter is a chip showing `field operator value`.
- Click a chip to edit it.
- `×` removes the filter.
- `+ Add filter` opens a dropdown of available fields: Status, Priority, Assignee, Project, Goal, Created date, Labels, Creator.
- Filters are AND-composed.
- Active filters persist in the URL query string so they're shareable/bookmarkable.

### 5.3 Issue Detail View (Three-Pane)

Clicking an issue opens the detail view. The main content area splits into two zones, with the sidebar still visible on the left.

```
┌──────────┬────────────────────────────────┬──────────────────────┐
│          │ Issues › CLIP-42               │                      │
│ Sidebar  │                                │   Properties     [+] │
│          │ Fix user authentication bug    │                      │
│          │ Implement proper token...      │   Status    In Progress │
│          │                                │   Priority  High     │
│          │ ┌──────────────────────────┐   │   Assignee  CTO      │
│          │ │ Properties bar (inline)  │   │   Project   Auth     │
│          │ │ In Progress · High ·     │   │   Goal      Security │
│          │ │ CTO · Auth project · ... │   │   Labels    bug, auth│
│          │ └──────────────────────────┘   │   Start     Feb 15   │
│          │                                │   Target    Feb 20   │
│          │ Description                    │   Created   Feb 14   │
│          │ ─────────────────              │                      │
│          │ The current authentication     │   ─────────────────  │
│          │ system has a token refresh...  │   Activity           │
│          │                                │   CTO commented 2h   │
│          │ Comments                       │   Status → In Prog   │
│          │ ─────────────────              │   Created by Board   │
│          │ [avatar] CTO · 2 hours ago     │                      │
│          │ I've identified the root...    │                      │
│          │                                │                      │
│          │ [avatar] DevOps · 1 hour ago   │                      │
│          │ The CI is set up to run...     │                      │
│          │                                │                      │
│          │ ┌──────────────────────────┐   │                      │
│          │ │ Write a comment...       │   │                      │
│          │ └──────────────────────────┘   │                      │
└──────────┴────────────────────────────────┴──────────────────────┘
```

#### Middle Pane (Main Content)

**Header area:**
- Issue title, large (18px, semi-bold), editable on click (inline editing).
- Subtitle: issue key `CLIP-42` in muted text.
- Below the title: inline properties bar showing key properties as clickable chips (same pattern as reference screenshots): `[○ In Progress] [!!! High] [👤 CTO] [📅 Target date] [📁 Auth] [···]`. Each chip is clickable to change that property inline.

**Description:**
- Markdown-rendered description.
- Click to edit — opens a markdown editor in-place.
- Support for headings, lists, code blocks, links, images.

**Subtasks (if any):**
- Listed below description as a collapsible section.
- Each subtask is a mini issue row (status circle + title + assignee).
- `+ Add subtask` button at the bottom.

**Comments:**
- Chronological list of comments.
- Each comment shows: author avatar/icon, author name, timestamp, body (markdown rendered).
- Comment input at the bottom — a text area with markdown support and a "Comment" button.
- Comments from agents show a bot icon; comments from the board show a user icon.

#### Right Pane (Properties Panel)

**Header:** "Properties" label with a `+` button to add a custom field.

**Property list:** Each property is a row with label on the left and editable value on the right.

| Property | Control |
|----------|---------|
| Status | Dropdown with status options + colored dot |
| Priority | Dropdown with priority options + icon |
| Assignee | Agent picker dropdown with search |
| Project | Project picker dropdown |
| Goal | Goal picker dropdown |
| Labels | Multi-select tag input |
| Lead | Agent picker |
| Members | Multi-select agent picker |
| Start date | Date picker |
| Target date | Date picker |
| Created by | Read-only text |
| Created | Read-only timestamp |
| Billing code | Text input |

Below properties, a divider, then:

**Activity section:**
- "Activity" header with "See all" link.
- Compact timeline of recent events: status changes, assignment changes, comments, etc.
- Each entry: icon + description + relative timestamp.

### 5.4 New Issue Modal

Triggered by the sidebar pencil icon, keyboard shortcut `C`, or the `+` buttons in the issue list.

```
┌─────────────────────────────────────────────────────────┐
│ [📁 CLIP] › New issue               [Save as draft] [↗] [×] │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ Issue title                                             │
│ ___________________________________________________     │
│                                                         │
│ Add a description...                                    │
│                                                         │
│                                                         │
│                                                         │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ [○ Todo] [--- Priority] [👤 Assignee] [📁 Project]     │
│ [🏷 Labels] [···]                                       │
├─────────────────────────────────────────────────────────┤
│ [📎]                    [◻ Create more] [Create issue]  │
└─────────────────────────────────────────────────────────┘
```

**Top bar:**
- Breadcrumb showing context: project key (or company key) `›` "New issue".
- "Save as draft" button.
- Expand icon (open as full page instead of modal).
- Close `×`.

**Body:**
- Title field: large input, placeholder "Issue title". Auto-focused on open.
- Description: markdown editor below, placeholder "Add a description...". Expandable.

**Property chips (bottom bar):**
- Compact row of property buttons. Each opens a dropdown to set that property.
- Default chips shown: Status (defaults to Todo), Priority, Assignee, Project, Labels.
- `···` more button reveals: Goal, Start date, Target date, Billing code, Parent issue.

**Footer:**
- Attachment button (paperclip icon).
- "Create more" toggle — when on, creating an issue clears the form and stays open for rapid entry.
- "Create issue" primary button.

**Behavior:**
- `Cmd+Enter` submits the form.
- If opened from within a project context, the project is pre-filled.
- If opened from a specific status group's `+` button, that status is pre-filled.
- The slug/key is auto-generated from the project prefix + incrementing number (shown in breadcrumb).

### 5.5 Issue Board View (Kanban)

Accessible via Display dropdown → Board layout.

Columns represent statuses: Backlog | Todo | In Progress | In Review | Done

Each card shows:
- Issue key (muted)
- Title (primary text)
- Priority icon (bottom-left)
- Assignee avatar (bottom-right)

Cards are draggable between columns. Dragging a card to a new column changes its status (with transition validation — invalid transitions show an error toast).

Each column header has a `+` button to create a new issue in that status.

---

## 6. Projects

### 6.1 Project List View

Similar to the issue list but for projects.

```
┌─────────────────────────────────────────────────────────┐
│ Projects                                [+ New project] │
├─────────────────────────────────────────────────────────┤
│ [icon] Paperclip Auth     Backlog     CTO     Feb 20   │
│ [icon] Marketing Site     In Progress CMO     Mar 01   │
│ [icon] API v2             Planned     CTO     Mar 15   │
└─────────────────────────────────────────────────────────┘
```

Each row: project icon (colored hexagon), name, status badge, lead agent, target date.

### 6.2 Project Detail View (Three-Pane)

Uses the same three-pane layout as issue detail.

**Breadcrumb tabs:** Overview | Updates | Issues | Settings

**Overview tab (middle pane):**
- Project icon + name (editable)
- Description (markdown, editable)
- Inline properties bar: `[◌ Backlog] [--- No priority] [👤 Lead] [📅 Target date] [🏢 Team] [···]`
- "Resources" section: linked documents, URLs
- "Write first project update" CTA (for project updates/status posts)
- Description (markdown body)
- Milestones section (collapsible): list of milestone markers with date and status

**Issues tab:** filtered issue list showing only issues in this project. Same controls as the main issues view.

**Right pane (properties):** Status, Priority, Lead, Members, Start date, Target date, Teams, Labels, Goal link.

**Activity section:** at the bottom of the properties panel.

---

## 7. Goals

### 7.1 Goal List View

Goals are displayed as a hierarchical tree, since goals have parent-child relationships.

```
┌─────────────────────────────────────────────────────────┐
│ Goals                                    [+ New goal]   │
├─────────────────────────────────────────────────────────┤
│ ▼ 🎯 Build the #1 AI note-taking app    Company  Active│
│   ▼ 🎯 Grow signups to 10k              Team     Active│
│       🎯 Launch marketing campaign       Agent  Planned │
│       🎯 Optimize onboarding funnel      Agent  Planned │
│   ▼ 🎯 Ship v2.0 with AI features       Team     Active│
│       🎯 Implement smart search          Task   Planned │
│       🎯 Build auto-summarization        Task   Planned │
└─────────────────────────────────────────────────────────┘
```

Each row: expand chevron (if has children), target icon, title, level badge (Company/Team/Agent/Task), status badge.

Indentation reflects hierarchy. Clicking a goal opens its detail view.

### 7.2 Goal Detail View

Three-pane layout. Middle pane shows title, description, child goals, and linked projects. Right pane shows properties (level, status, owner agent, parent goal) and activity.

---

## 8. Dashboard

The dashboard is the company health overview. Shown when clicking "Dashboard" in the Company section.
It stays intentionally narrow: telemetry, counts, spend, approvals, and stale-task surfacing.
Executive interpretation, durable outputs, and decision summaries belong in the separate **Briefings** surface.

### 8.1 Layout

```
┌──────────┬──────────────────────────────────────────────┐
│          │ Dashboard                                     │
│ Sidebar  │                                               │
│          │ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────┐│
│          │ │ Agents   │ │ Tasks   │ │ Costs   │ │Apprvl││
│          │ │ 12 total │ │ 47 open │ │ $234.50 │ │ 3    ││
│          │ │ 8 active │ │ 12 prog │ │ 67% bud │ │pending│
│          │ │ 2 paused │ │ 3 block │ │         │ │      ││
│          │ │ 1 error  │ │ 28 done │ │         │ │      ││
│          │ └─────────┘ └─────────┘ └─────────┘ └──────┘│
│          │                                               │
│          │ ┌────────────────────┐ ┌─────────────────────┐│
│          │ │ Recent Activity    │ │ Stale Tasks          ││
│          │ │ ...                │ │ ...                   ││
│          │ └────────────────────┘ └─────────────────────┘│
└──────────┴──────────────────────────────────────────────┘
```

**Top row: Metric cards** (4 across)
1. **Agents** — total, active, running, paused, error counts. Each with colored dots.
2. **Tasks** — open, in progress, blocked, done counts.
3. **Costs** — month-to-date spend in dollars, budget utilization percentage with a mini progress bar.
4. **Approvals** — pending count (clickable to navigate to Inbox, which is the primary approval interaction point).

**Bottom row: Detail panels** (2 across)
5. **Recent Activity** — last ~10 activity log entries, compact timeline format.
6. **Stale Tasks** — tasks that have been in progress for too long without updates. Each shows issue key, title, assignee, time since last activity.

All cards and panels are clickable to navigate to their respective full pages.

---

## 9. Org Chart

Interactive visualization of the agent reporting hierarchy.

### 9.1 Tree View

```
                    ┌─────────┐
                    │ CEO     │
                    │ running │
                    └────┬────┘
            ┌────────────┼────────────┐
       ┌────┴────┐  ┌────┴────┐  ┌───┴─────┐
       │ CTO     │  │ CMO     │  │ CFO     │
       │ active  │  │ idle    │  │ paused  │
       └────┬────┘  └────┬────┘  └─────────┘
       ┌────┴────┐  ┌────┴────┐
       │ Dev-1   │  │ Mktg-1  │
       │ running │  │ idle    │
       └─────────┘  └─────────┘
```

Each node shows:
- Agent name
- Role/title (smaller text)
- Status dot (colored by agent status)
- Agent avatar (bot icon with unique color per agent)

Nodes are clickable to navigate to agent detail.

### 9.2 Interactions

- Zoom/pan with mouse wheel and drag.
- Click a node to select it — shows a brief tooltip with key info (last heartbeat, current task, spend).
- Double-click a node to navigate to agent detail page.
- Right-click node for context menu: View, Pause, Resume, Invoke heartbeat, Edit.

---

## 10. Agents

### 10.1 Agent List View

```
┌─────────────────────────────────────────────────────────────────┐
│ Agents                                          [+ New agent]   │
├─────────────────────────────────────────────────────────────────┤
│ [🤖] CEO           ceo        ● Running   $45.20/$100   2m ago │
│ [🤖] CTO           cto        ● Active    $23.10/$100   5m ago │
│ [🤖] Dev-1         engineer   ○ Idle      $12.40/$50   15m ago │
│ [🤖] CMO           marketing  ○ Idle      $8.30/$50    30m ago │
│ [🤖] DevOps        devops     ⚠ Paused    $31.00/$50    1h ago │
└─────────────────────────────────────────────────────────────────┘
```

Columns: Avatar/icon, Name, Role, Status (with colored dot), Cost (spent/budget this month), Last Heartbeat (relative time).

Clicking a row navigates to agent detail.

### 10.2 Agent Detail View (Three-Pane)

**Breadcrumb tabs:** Overview | Heartbeats | Issues | Costs

**Overview (middle pane):**
- Agent name + role
- Capabilities description
- Adapter type + config summary
- Current task (if any)
- Reports to: [clickable agent name]
- Direct reports: list of agents

**Heartbeats tab:** table of heartbeat runs — time, source (manual/scheduler), status, duration, error (if any). Invoke button at top.

**Issues tab:** issues assigned to this agent.

**Costs tab:** cost breakdown for this agent — by model, by time period, with budget progress bar.

**Right pane properties:** Status, Role, Title, Reports To, Adapter Type, Context Mode, Budget (monthly), Spent (monthly), Last Heartbeat.

**Quick actions** in breadcrumb bar: [Pause] [Resume] [Invoke Heartbeat] [···]

---

## 11. Approvals (Contextual, Not Standalone)

Approvals are governance gates — decisions the board must make (hire an agent, approve a CEO strategy). They are NOT work items. Their data model stays separate from issues (different status machine, side-effect triggers, unstructured payload). But they don't need their own top-level nav entry.

### 11.1 Where Approvals Surface

**1. Inbox (primary).** Pending approvals are the highest-priority inbox items. The board operator sees them front and center with inline approve/reject actions (see Section 14).

**2. Dashboard metric card.** The "Pending Approvals" card shows the count and links to the full approvals list.

**3. Inline on entity pages.** When an entity was created via an approval, the detail page shows a contextual banner:
- Agent detail page: `"Hired via approval — requested by CEO on Feb 15"` with a link to the approval record.
- An agent in `pending` status (not yet created) could show: `"Pending approval — requested by CEO"` with approve/reject actions inline.

**4. Activity log.** Approval events (created, approved, rejected) appear in the activity timeline like any other event.

### 11.2 Approvals List Page (`/approvals`)

This page still exists — it's the "See all" destination from Inbox and Dashboard. But it's not in the sidebar.

```
┌─────────────────────────────────────────────────────────┐
│ Approvals    [Pending] [Approved] [Rejected] [All]      │
├─────────────────────────────────────────────────────────┤
│ 🟡 Hire Agent: "Marketing Analyst"    CEO    2h ago     │
│ 🟡 CEO Strategy: "Q2 Growth Plan"    CEO    4h ago     │
│ 🟢 Hire Agent: "DevOps Engineer"     CTO    1d ago     │
└─────────────────────────────────────────────────────────┘
```

Status tabs filter by approval status. Each row: status dot, type, title/summary (from payload), requester, relative time.

### 11.3 Approval Detail View

Three-pane layout. Middle pane renders the approval payload nicely based on type:

**`hire_agent` type:** Shows proposed agent name, role, title, reports-to, capabilities, adapter config, budget. Essentially a preview of the agent that will be created.

**`approve_ceo_strategy` type:** Shows the strategy text, proposed goal breakdown, initial task structure.

For pending approvals, prominent action buttons at the top of the middle pane:
```
┌─────────────────────────────────────────────────────────┐
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Decision note (optional): _________________________ │ │
│ │                          [✕ Reject]  [✓ Approve]    │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ Hire Agent Request                                      │
│ ─────────────────                                       │
│ Name: Marketing Analyst                                 │
│ Role: marketing                                         │
│ Reports to: CMO                                         │
│ Budget: $100/month                                      │
│ ...                                                     │
└─────────────────────────────────────────────────────────┘
```

Right pane: Type, Status, Requested by, Requested at, Decided by, Decided at, Decision note. Activity timeline below.

---

## 12. Costs

### 12.1 Cost Dashboard

```
┌─────────────────────────────────────────────────────────┐
│ Costs                               Feb 2026            │
├─────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────┐│
│ │ Month-to-date: $234.50 / $500.00  [====-------] 47% ││
│ └──────────────────────────────────────────────────────┘│
│                                                         │
│ By Agent                              By Project        │
│ ┌──────────────────────┐  ┌──────────────────────┐      │
│ │ CEO        $45.20    │  │ Auth       $67.30    │      │
│ │ CTO        $23.10    │  │ Marketing  $34.50    │      │
│ │ Dev-1      $12.40    │  │ API v2     $12.00    │      │
│ │ ...                  │  │ ...                  │      │
│ └──────────────────────┘  └──────────────────────┘      │
│                                                         │
│ Recent Cost Events                                      │
│ ┌──────────────────────────────────────────────────────┐│
│ │ CEO  openai/gpt-5  1,234 in / 567 out  $0.89  2m ago│
│ │ ...                                                   │
│ └──────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

Top: company-wide budget progress bar (large, prominent).

Two side-by-side tables: breakdown by agent and by project. Each row shows entity name and spend amount.

Bottom: recent cost events table with agent, provider/model, token counts, cost, and timestamp.

---

## 13. Activity Log

A chronological, filterable audit trail.

```
┌─────────────────────────────────────────────────────────┐
│ Activity                            [Filter by type ▼]  │
├─────────────────────────────────────────────────────────┤
│ 🤖 CEO created issue CLIP-12 "Fix auth"      2 min ago │
│ 👤 Board approved hire "Marketing Analyst"    5 min ago │
│ 🤖 CTO changed CLIP-8 status → In Progress  10 min ago │
│ ⚙  System paused agent DevOps (budget limit) 15 min ago│
│ 🤖 Dev-1 commented on CLIP-5                30 min ago │
│ ...                                                     │
└─────────────────────────────────────────────────────────┘
```

Each entry: actor icon (bot for agent, user for board, gear for system), actor name, action description with entity links, relative timestamp.

Filterable by: actor type (agent/user/system), entity type (issue/agent/project/etc), action type, time range.

Infinite scroll with "Load more" fallback.

---

## 14. Inbox

The inbox is the board operator's primary action center. It aggregates everything that needs human attention, with approvals as the highest-priority category.

### 14.1 Inbox List View

```
┌─────────────────────────────────────────────────────────┐
│ Inbox                               [Mark all read]     │
├─────────────────────────────────────────────────────────┤
│ APPROVALS                        See all approvals →    │
│ ● 🛡 Hire Agent: "Marketing Analyst"                    │
│ │  Requested by CEO · 2h ago                            │
│ │  Role: marketing · Reports to: CMO · Budget: $100/mo  │
│ │  [✕ Reject]  [✓ Approve]                              │
│ │                                                       │
│ ● 🛡 CEO Strategy: "Q2 Growth Plan"                     │
│ │  Requested by CEO · 4h ago                            │
│ │  [View details →]                                     │
│                                                         │
│ ALERTS                                                  │
│ ● 🔴 Agent Error: DevOps heartbeat failed       1h ago  │
│ ● ⚠  Budget Alert: CEO at 80% monthly budget   3h ago  │
│                                                         │
│ STALE WORK                                              │
│   ⏰ CLIP-3 "Set up CI pipeline" — no update in 24h     │
│   ⏰ CLIP-7 "Write tests" — no update in 36h            │
└─────────────────────────────────────────────────────────┘
```

### 14.2 Inbox Categories

Items are grouped by category, with the most actionable items first:

**Approvals pending** (top priority). Each approval item shows:
- Shield icon + approval type + title
- Requester + relative timestamp
- Key payload summary (1 line — agent name/role for hires, plan title for strategies)
- Inline **[Approve]** and **[Reject]** buttons for simple approvals (hire_agent). Clicking Approve/Reject shows a brief confirmation with an optional decision note field.
- **[View details →]** link for complex approvals (approve_ceo_strategy) that need full review before deciding.
- "See all approvals →" link in the category header navigates to `/approvals`.

**Alerts.** Agent errors (failed heartbeats, error status) and budget alerts (agents or company approaching 80% or 100% limits). Each links to the relevant agent or cost page.

**Stale work.** Tasks in `in_progress` or `todo` with no activity (no comments, no status changes) beyond a configurable threshold (default: 24h). Each shows issue key, title, and time since last activity. Clicking navigates to the issue.

### 14.3 Inbox Behavior

- Unread items have a filled blue dot indicator on the left.
- Clicking an item marks it as read.
- Approvals disappear from the inbox once approved/rejected (they move to the resolved state).
- Alerts disappear when the underlying condition is resolved (agent resumed, budget increased).
- The sidebar badge count reflects total unresolved inbox items.
- Inbox is computed from live data (pending approvals query + alert conditions), not a separate notification table. This keeps it simple for V1.

---

## 15. Search (Cmd+K Modal)

Global search accessible via `Cmd+K` or the sidebar search icon.

```
┌─────────────────────────────────────────────────────────┐
│ 🔍 Search issues, agents, projects...                   │
├─────────────────────────────────────────────────────────┤
│ Recent                                                  │
│   📋 CLIP-42 Fix user authentication bug                │
│   🤖 CEO                                                │
│   📁 Auth project                                       │
├─────────────────────────────────────────────────────────┤
│ Actions                                                 │
│   ✏️  Create new issue                         C        │
│   🤖 Create new agent                                   │
│   📁 Create new project                                 │
└─────────────────────────────────────────────────────────┘
```

- Type-ahead search across all entity types (issues, agents, projects, goals).
- Results grouped by type with icons.
- Recent items shown when input is empty.
- Quick actions section at the bottom.
- Arrow keys to navigate, Enter to select, Escape to close.

---

## 16. Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+K` | Open search |
| `C` | Create new issue |
| `Cmd+Enter` | Submit form (in modals) |
| `Escape` | Close modal / deselect |
| `[` | Toggle sidebar collapsed |
| `]` | Toggle properties panel |
| `J` / `K` | Navigate up/down in lists |
| `Enter` | Open selected item |
| `Backspace` | Go back |
| `S` | Toggle status on selected issue |
| `X` | Toggle checkbox selection |
| `Cmd+A` | Select all (in list context) |

---

## 17. Responsive Behavior

- **>1400px:** Full three-pane layout (sidebar + main + properties).
- **1024-1400px:** Sidebar collapses to icons. Properties panel available via toggle.
- **<1024px:** Sidebar hidden (hamburger menu). Properties panel hidden (toggle or tab).

The properties panel is always dismissible — it should never block the main content.

---

## 18. Empty States

Every list view should have a thoughtful empty state:

- **No issues:** "No issues yet. Create your first issue to start tracking work." with a `[Create issue]` button.
- **No agents:** "No agents in this company. Create an agent to start building your team." with a `[Create agent]` button.
- **No company selected:** "Select a company to get started." with a company switcher or `[Create company]` button.

Empty states should use a muted illustration (simple line art, not cartoons) and a single call-to-action.

---

## 19. Loading and Error States

- **Loading:** Skeleton placeholders matching the layout of the expected content (not spinners). Skeleton blocks animate with a subtle shimmer.
- **Error:** Inline error message with a retry button. Never a full-page error unless the app itself is broken.
- **Conflict (409):** Toast notification: "This issue was updated by another user. Refresh to see changes." with a [Refresh] action.
- **Optimistic updates:** Status changes and property edits should update immediately in the UI, with rollback on failure.

---

## 20. Component Library

Build on top of shadcn/ui components with these customizations:

| Component | Base | Customization |
|-----------|------|---------------|
| StatusBadge | Badge | Colored dot + label, entity-specific palettes |
| PriorityIcon | custom | SVG circles with fills matching priority |
| EntityRow | custom | Standardized list row with hover/select states |
| PropertyEditor | custom | Label + inline-editable value with dropdown |
| CommentThread | custom | Avatar + author + timestamp + markdown body |
| BreadcrumbBar | Breadcrumb | Integrated with router, tabs, and entity actions |
| CommandPalette | Dialog | Cmd+K search with type-ahead and actions |
| FilterBar | custom | Composable filter chips with add/remove |
| SidebarNav | custom | Grouped, collapsible, badge-supporting nav |

---

## 21. URL Structure

All routes are company-scoped after company selection (company context stored in React context, not URL):

```
/                           → redirects to /dashboard
/dashboard                  → company dashboard
/briefings                  → redirects to /briefings/board
/briefings/board            → executive board
/briefings/results          → durable results library
/briefings/plans            → durable planning library
/briefings/records/:recordId → plan/result/briefing detail
/inbox                      → inbox / attention items
/my-issues                  → board operator's issues
/issues                     → issue list
/issues/:issueId            → issue detail
/projects                   → project list
/projects/:projectId        → project detail (overview tab)
/projects/:projectId/issues → project issues
/goals                      → goal hierarchy
/goals/:goalId              → goal detail
/org                        → org chart
/agents                     → agent list
/agents/:agentId            → agent detail
/approvals                  → approval list
/approvals/:approvalId      → approval detail
/costs                      → cost dashboard
/activity                   → activity log
/companies                  → company management (list/create)
/settings                   → company settings
```

---

## 22. Implementation Priority

### Phase 1: Shell and Navigation
1. Sidebar redesign (grouped sections, icons, company switcher, badges)
2. Breadcrumb bar component
3. Three-pane layout system
4. Cmd+K search modal
5. Install `lucide-react`

### Phase 2: Issue Management (Core)
6. Issue list view with grouping, filtering, status circles
7. Issue detail view (three-pane with properties panel)
8. New issue modal
9. Issue comments
10. Bulk selection and actions
11. Kanban board view

### Phase 3: Entity Detail Views
12. Project list + detail view
13. Goal hierarchy view
14. Agent list + detail view

### Phase 4: Company-Level Views
15. Inbox with inline approval actions (primary approval UX)
16. Dashboard redesign with metric cards
17. Org chart interactive visualization
18. Cost dashboard
19. Activity log with filtering
20. Approvals list page (accessed via Inbox "See all", not sidebar)

### Phase 5: Polish
21. Keyboard shortcuts
22. Responsive behavior
23. Empty states and loading skeletons
24. Error handling and toasts
25. Saved views (custom filters)
