# Paperclip Component Index

Inventory of the **reusable** components under `ui/src/components/`. Update this file when
adding a new reusable component.

**Scope.** A component belongs here when it is meant to be imported by more than one place:
a shadcn/ui primitive, or a component reused across pages, boards, or panels. A one-off
layout that exists only for a single page does **not** belong here -- `SKILL.md` sec.6 says so,
and the census below counts that gap as out of scope, not as drift.

This file is **one of three** inventories of the same set, and all three must agree:

| | Artifact | What it is |
|---|---|---|
| A | `ui/src/components/**` | what exists on disk |
| B | this file | the documented index |
| C | the `Component Coverage` roster in `ui/src/pages/DesignGuide.tsx` | the badges the live `/design-guide` page renders |

`SKILL.md` sec.10 rule 1 and sec.11 tell an author to update **two** places. There are three.
The roster (C) is the one the guide never names, and the one a reader of `/design-guide` sees.
Run `python3 scripts/census-design-guide-inventory.py` to check all three agree; it exits 1 on
drift. Nothing runs it automatically yet, so it only holds if you run it -- see
SKILL.md sec. 11.1.

---

## Table of Contents

1. [shadcn/ui Primitives](#shadcnui-primitives)
2. [Custom Components](#custom-components)
3. [Layout Components](#layout-components)
4. [Dialog & Form Components](#dialog--form-components)
5. [Property Panel Components](#property-panel-components)
6. [Agent Configuration](#agent-configuration)
7. [Utilities & Hooks](#utilities--hooks)

---

## shadcn/ui Primitives

Location: `ui/src/components/ui/`

These are shadcn/ui base components. Do not modify directly — extend via composition.

| Component | File | Key Props | Notes |
|-----------|------|-----------|-------|
| Button | `button.tsx` | `variant` (default, secondary, outline, ghost, destructive, link), `size` (xs, sm, default, lg, icon, icon-xs, icon-sm, icon-lg) | Primary interactive element. Uses CVA. |
| Card | `card.tsx` | CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter | Compound component. `py-6` default padding. |
| Input | `input.tsx` | `disabled` | Standard text input. |
| Badge | `badge.tsx` | `variant` (default, secondary, outline, destructive, ghost) | Generic label/tag. For status, use StatusBadge instead. |
| Label | `label.tsx` | — | Form label, wraps Radix Label. |
| Select | `select.tsx` | Trigger, Content, Item, etc. | Radix-based dropdown select. |
| Separator | `separator.tsx` | `orientation` (horizontal, vertical) | Divider line. |
| Checkbox | `checkbox.tsx` | `checked`, `onCheckedChange` | Radix checkbox with indicator. |
| Textarea | `textarea.tsx` | Standard textarea props | Multi-line input. |
| Avatar | `avatar.tsx` | `size` (sm, default, lg). Includes AvatarGroup, AvatarGroupCount | Image or fallback initials. |
| Breadcrumb | `breadcrumb.tsx` | BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbSeparator, BreadcrumbPage | Navigation breadcrumbs. |
| Command | `command.tsx` | CommandInput, CommandList, CommandGroup, CommandItem | Command palette / search. Based on cmdk. |
| Dialog | `dialog.tsx` | DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter | Modal overlay. |
| DropdownMenu | `dropdown-menu.tsx` | Trigger, Content, Item, Separator, etc. | Context/action menus. |
| Popover | `popover.tsx` | PopoverTrigger, PopoverContent | Floating content panel. |
| Tabs | `tabs.tsx` | `variant` (pill, line). TabsList, TabsTrigger, TabsContent | Tabbed navigation. Pill = default, line = underline style. |
| Tooltip | `tooltip.tsx` | TooltipTrigger, TooltipContent | Hover tooltips. App is wrapped in TooltipProvider. |
| ScrollArea | `scroll-area.tsx` | — | Custom scrollable container. |
| Collapsible | `collapsible.tsx` | CollapsibleTrigger, CollapsibleContent | Expand/collapse sections. |
| Skeleton | `skeleton.tsx` | className for sizing | Loading placeholder with shimmer. |
| Sheet | `sheet.tsx` | SheetTrigger, SheetContent, SheetHeader, etc. | Side panel overlay. |
| AlertDialog | `alert-dialog.tsx` | AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel | Destructive/irreversible confirmation. Kept distinct from Dialog so a destructive action cannot be confirmed with an ordinary dismissible panel. |
| Attachment | `attachment.tsx` | Attachment, AttachmentGroup, AttachmentMedia, AttachmentContent, AttachmentTitle, AttachmentDescription, AttachmentActions, AttachmentAction, AttachmentTrigger | File chip used in task chat bubbles and composers. `AttachmentMedia` is the icon/avatar slot; there is no `AttachmentIcon` export. |
| RadioCard | `radio-card.tsx` | RadioCardGroup, RadioCard, `RadioCardOption` (type) | Single-select that reads as a card. Every call site uses `RadioCardGroup`; `RadioCard` is the single-option primitive underneath it. |
| ResizablePanels | `resizable-panels.tsx` | ResizablePanelGroup, ResizablePanel, ResizableHandle | Resizable split layout (e.g. SkillStudio). Local reimplementation -- the exports are `Resizable*`-prefixed, not `Panel*`. |
| ToggleSwitch | `toggle-switch.tsx` | `checked`, `onCheckedChange` | Pill switch. 24 importing files -- the most-used of the five primitives this table had missed, and 14th of 26 overall -- so extend it via composition rather than hand-rolling a switch. |

---

## Custom Components

Location: `ui/src/components/`

### StatusBadge

**File:** `StatusBadge.tsx`
**Props:** `status: string`
**Usage:** Colored pill showing entity status. Supports 20+ statuses with mapped colors.

```tsx
<StatusBadge status="in_progress" />
```

Use for displaying status in properties panels, entity rows, and list views. Never hardcode status colors — always use this component.

### StatusIcon

**File:** `StatusIcon.tsx`
**Props:** `status: string`, `onChange?: (status: string) => void`
**Usage:** Circle icon representing issue status. When `onChange` provided, opens a popover picker.

```tsx
<StatusIcon status="todo" onChange={setStatus} />
```

Supports: backlog, todo, in_progress, in_review, done, cancelled, blocked. Use in entity row leading slots and grouped list headers.

### PriorityIcon

**File:** `PriorityIcon.tsx`
**Props:** `priority: string`, `onChange?: (priority: string) => void`
**Usage:** Priority indicator icon. Interactive when `onChange` provided.

```tsx
<PriorityIcon priority="high" onChange={setPriority} />
```

Supports: critical, high, medium, low. Use alongside StatusIcon in entity row leading slots.

### EntityRow

**File:** `EntityRow.tsx`
**Props:** `leading`, `identifier`, `title`, `subtitle?`, `trailing?`, `onClick?`, `selected?`
**Usage:** Standard list row for issues, agents, projects. Supports hover highlight and selected state.

```tsx
<EntityRow
  leading={<><StatusIcon status="todo" /><PriorityIcon priority="medium" /></>}
  identifier="PAP-003"
  title="Write API documentation"
  trailing={<StatusBadge status="todo" />}
  onClick={() => navigate(`/issues/${id}`)}
/>
```

Wrap multiple EntityRows in a `border border-border rounded-md` container.

### MetricCard

**File:** `MetricCard.tsx`
**Props:** `icon: LucideIcon`, `value: string | number`, `label: string`, `description?: string`
**Usage:** Dashboard stat card with icon, large value, label, and optional description.

```tsx
<MetricCard icon={Bot} value={12} label="Active Agents" description="+3 this week" />
```

Always use in a responsive grid: `grid md:grid-cols-2 xl:grid-cols-4 gap-4`.

### EmptyState

**File:** `EmptyState.tsx`
**Props:** `icon: LucideIcon`, `message: string`, `action?: string`, `onAction?: () => void`
**Usage:** Empty list placeholder with icon, message, and optional CTA button.

```tsx
<EmptyState icon={Inbox} message="No items yet." action="Create Item" onAction={handleCreate} />
```

### FilterBar

**File:** `FilterBar.tsx`
**Props:** `filters: FilterValue[]`, `onRemove: (key) => void`, `onClear: () => void`
**Type:** `FilterValue = { key: string; label: string; value: string }`
**Usage:** Filter chip display with remove buttons and clear all.

```tsx
<FilterBar filters={filters} onRemove={handleRemove} onClear={() => setFilters([])} />
```

### Identity

**File:** `Identity.tsx`
**Props:** `name: string`, `avatarUrl?: string`, `initials?: string`, `size?: "sm" | "default" | "lg"`
**Usage:** Avatar + name display for users and agents. Derives initials from name automatically. Three sizes matching Avatar sizes.

```tsx
<Identity name="Agent Alpha" size="sm" />
<Identity name="CEO Agent" />
<Identity name="Backend Service" size="lg" avatarUrl="/img/bot.png" />
```

Use in property rows, comment headers, assignee displays, and anywhere a user/agent reference is shown.

### InlineEditor

**File:** `InlineEditor.tsx`
**Props:** `value: string`, `onSave: (val: string) => void`, `as?: string`, `className?: string`
**Usage:** Click-to-edit text. Renders as display text, clicking enters edit mode. Enter saves, Escape cancels.

```tsx
<InlineEditor value={title} onSave={updateTitle} as="h2" className="text-xl font-bold" />
```

### PageSkeleton

**File:** `PageSkeleton.tsx`
**Props:** `variant: "list" | "detail"`
**Usage:** Full-page loading skeleton matching list or detail layout.

```tsx
<PageSkeleton variant="list" />
```

### CommentThread

**File:** `CommentThread.tsx`
**Usage:** Comment list with add-comment form. Used on issue and entity detail views.

### GoalTree

**File:** `GoalTree.tsx`
**Usage:** Hierarchical goal tree with expand/collapse. Used on the goals page.

### CompanySwitcher

**File:** `CompanySwitcher.tsx`
**Usage:** Company selector dropdown in sidebar header.

### InlineBanner

**File:** `InlineBanner.tsx`
**Props:** `tone?` (`info` | `warning` | `danger`, default `info`), `title?`, `icon?` (override, or `false` to omit), `actions?`, `compact?`
**Usage:** In-flow notice rendered inside a page or a dialog -- `compact` is for embedding in a modal. Prefer this over a Dialog for anything that does not need to block the user's next action.

### MarkdownEditor

**File:** `MarkdownEditor.tsx`
**Usage:** Markdown authoring surface with a rendered/preview split. Pair with `MarkdownBody` for read-only rendering.

### CollectionToolbar

**File:** `CollectionToolbar.tsx`
**Props:** `context?`, `search?`, `controls?`, `actions?`, `feedback?`, `ariaLabel?`
**Usage:** The shared toolbar geometry above a list -- the page owns its state and behaviour, the toolbar owns the slot layout. The canonical task row is opt-in during migration: status leads, unread work uses title emphasis, metadata stays stable, the task identifier trails.

```tsx
<CollectionToolbar
  context={<span className="text-sm font-medium">Recent tasks</span>}
  search={<Input placeholder="Search task collection..." />}
  actions={<Button size="sm">New task</Button>}
/>
```

### ContextualSidebarFrame

**File:** `ContextualSidebarFrame.tsx`
**Props:** `surface`, `title`, `icon?`, `fallbackTo?`, `showHeader?`
**Usage:** Chrome for the secondary sidebar that opens over a primary surface. Owns the back affordance and the origin round-trip via `readContextualSidebarOrigin`, so a contextual sidebar returns the user where they came from instead of dumping them on the dashboard.

### BuiltInAgentGate

**File:** `BuiltInAgentGate.tsx`
**Props:** `agentKey`, `companyId`, `featureLabel?`, `children`
**Usage:** Wraps any feature surface that depends on a built-in agent and renders the correct lifecycle state for it (not configured / awaiting approval / live). Use it instead of branching on the agent's status at each call site.

### BuiltInLifecycleChip

**File:** `BuiltInAgentBadges.tsx`
**Props:** `status: BuiltInAgentStatus`, `compact?`
**Usage:** Amber chip for the built-in agent's *lifecycle* states (`needs_setup`, `pending_approval`) only; it renders `null` for every real run status. Kept separate from the agent status badge on purpose -- do not merge them.

### EnvironmentVariablesEditor

**File:** `environment-variables-editor/index.tsx` (barrel)
**Usage:** Key/value editor for environment variables with per-row validation. Barrel directory, not a flat `.tsx` -- import from the directory, not a guessed filename.

### IssueRow

**File:** `IssueRow.tsx`
**Props:** `issue`, `presentation?: "legacy" | "task"`, `selected?`, `leadingControl?`, `statusSlot?`, `metadata?`, `actions?`, `showIdentifier?`, `mobileLeading?`, `desktopTrailing?`, `trailingMeta?`, `titleSuffix?`
**Usage:** The canonical task-list row. `presentation="task"` opts into the canonical collection layout (status leads, unread work uses title emphasis, metadata stays stable, identifier trails); `legacy` remains the default while surfaces migrate, so a new list should ask which one it wants rather than inherit whichever the last caller used. Pair with `CollectionToolbar`, which owns the geometry above it.

---

## Layout Components

### Layout

**File:** `Layout.tsx`
**Usage:** Main app shell. Three-zone layout: Sidebar + Main content + Properties panel. Wraps all routes.

### Sidebar

**File:** `Sidebar.tsx`
**Usage:** Left navigation sidebar (`w-60`). Contains CompanySwitcher, search button, new issue button, and SidebarSections.

### SidebarSection

**File:** `SidebarSection.tsx`
**Usage:** Collapsible sidebar group with header label and chevron toggle.

### SidebarNavItem

**File:** `SidebarNavItem.tsx`
**Props:** Icon, label, optional badge count
**Usage:** Individual nav item within a SidebarSection.

### BreadcrumbBar

**File:** `BreadcrumbBar.tsx`
**Usage:** Top breadcrumb navigation spanning main content + properties panel.

### PropertiesPanel

**File:** `PropertiesPanel.tsx`
**Usage:** Right-side properties panel (`w-80`). Closeable. Shown on detail views.

### CommandPalette

**File:** `CommandPalette.tsx`
**Usage:** Cmd+K global search modal. Searches issues, projects, agents.

---

## Dialog & Form Components

### NewIssueDialog

**File:** `NewIssueDialog.tsx`
**Usage:** Create new issue with project/assignee/priority selection. Supports draft saving.

### NewProjectDialog

**File:** `NewProjectDialog.tsx`
**Usage:** Create new project dialog.

### NewAgentDialog

**File:** `NewAgentDialog.tsx`
**Usage:** Create new agent dialog.

### OnboardingWizard

**File:** `OnboardingWizard.tsx`
**Usage:** Multi-step onboarding flow for new users/companies.

---

## Property Panel Components

These render inside the PropertiesPanel for different entity types:

| Component | File | Entity |
|-----------|------|--------|
| IssueProperties | `IssueProperties.tsx` | Issues |
| AgentProperties | `AgentProperties.tsx` | Agents |
| ProjectProperties | `ProjectProperties.tsx` | Projects |
| GoalProperties | `GoalProperties.tsx` | Goals |

All follow the property row pattern: `text-xs text-muted-foreground` label on left, value on right, `py-1.5` spacing.

---

## Agent Configuration

### agent-config-primitives

**File:** `agent-config-primitives.tsx`
**Exports:** Field, ToggleField, ToggleWithNumber, CollapsibleSection, AutoExpandTextarea, DraftInput
**Usage:** Reusable form field primitives for agent configuration forms.

### AgentConfigForm

**File:** `AgentConfigForm.tsx`
**Usage:** Full agent creation/editing form with adapter type selection.

---

## Utilities & Hooks

### cn() — Class Name Merger

**File:** `ui/src/lib/utils.ts`
**Usage:** Merges class names with clsx + tailwind-merge. Use in every component.

```tsx
import { cn } from "@/lib/utils";
<div className={cn("base-classes", conditional && "extra", className)} />
```

### Formatting Utilities

**File:** `ui/src/lib/utils.ts`

| Function | Usage |
|----------|-------|
| `formatCents(cents)` | Money display: `$12.34` |
| `formatDate(date)` | Date display: `Jan 15, 2025` |
| `relativeTime(date)` | Relative time: `2m ago`, `Jan 15` |
| `formatTokens(count)` | Token counts: `1.2M`, `500k` |

### useKeyboardShortcuts

**File:** `ui/src/hooks/useKeyboardShortcuts.ts`
**Usage:** Global keyboard shortcut handler. Registers Cmd+K, C, [, ], Cmd+Enter.

### Query Keys

**File:** `ui/src/lib/queryKeys.ts`
**Usage:** Structured React Query key factories for cache management.

### groupBy

**File:** `ui/src/lib/groupBy.ts`
**Usage:** Generic array grouping utility.
