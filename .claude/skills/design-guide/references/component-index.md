# Paperclip Component Index

Complete inventory of all UI components. Update this file when adding new reusable components.

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
