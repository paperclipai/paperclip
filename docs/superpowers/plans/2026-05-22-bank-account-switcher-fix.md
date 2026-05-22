# Broken Workspace Switcher Fix — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix invisible workspace switcher dropdown after navigation by removing dead animation classes and increasing z-index.

**Architecture:** Six UI component files (Radix UI wrappers) need the same edit: strip non-existent animation/transition classes from className strings.

**Tech Stack:** TypeScript, React 19, Tailwind CSS v4, Radix UI

---

### Task 1: Fix dropdown-menu.tsx (primary fix — the workspace switcher)

**Files:**
- Modify: `ui/src/components/ui/dropdown-menu.tsx`

- [ ] **Step 1: Remove dead animation classes from DropdownMenuContent**

Old className (line 45):
```
z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-md
```
was preceded by:
```
data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2
```

Change `z-50` to `z-[100]`.

New className for DropdownMenuContent (line 45):
```
"bg-popover text-popover-foreground z-[100] max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-md",
```

- [ ] **Step 2: Remove dead animation classes from DropdownMenuSubContent**

Old className (line 233):
```
z-50 min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-md border p-1 shadow-lg
```
was preceded by:
```
data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2
```

Change `z-50` to `z-[100]`.

New className for DropdownMenuSubContent (line 233):
```
"bg-popover text-popover-foreground z-[100] min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-md border p-1 shadow-lg",
```

- [ ] **Step 3: Verify the file**

### Task 2: Fix popover.tsx

**Files:**
- Modify: `ui/src/components/ui/popover.tsx`

- [ ] **Step 1: Remove dead animation classes from PopoverContent**

Old className (line 31):
```
z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-md border p-4 shadow-md outline-hidden
```
was preceded by:
```
data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2
```

New className (line 31):
```
"bg-popover text-popover-foreground z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-md border p-4 shadow-md outline-hidden",
```

### Task 3: Fix dialog.tsx

**Files:**
- Modify: `ui/src/components/ui/dialog.tsx`

- [ ] **Step 1: Remove dead animation classes from DialogOverlay**

Old className (line 40):
```
data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50 duration-100
```

New className (line 40):
```
"fixed inset-0 z-50 bg-black/50"
```

- [ ] **Step 2: Remove dead animation classes from DialogContent**

Old className (line 62):
```
bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-[0.97] data-[state=open]:zoom-in-[0.97] data-[state=closed]:slide-out-to-top-[1%] data-[state=open]:slide-in-from-top-[1%] fixed top-[max(1rem,env(safe-area-inset-top))] md:top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-0 md:translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] outline-none sm:max-w-lg [&>*]:min-w-0
```

New className (line 62):
```
"bg-background fixed top-[max(1rem,env(safe-area-inset-top))] md:top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-0 md:translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg outline-none sm:max-w-lg [&>*]:min-w-0"
```

### Task 4: Fix tooltip.tsx

**Files:**
- Modify: `ui/src/components/ui/tooltip.tsx`

- [ ] **Step 1: Remove dead animation classes from TooltipContent**

Old className (line 45):
```
bg-foreground text-background animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md px-3 py-1.5 text-xs text-balance
```

New className (line 45):
```
"bg-foreground text-background z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md px-3 py-1.5 text-xs text-balance"
```

### Task 5: Fix select.tsx

**Files:**
- Modify: `ui/src/components/ui/select.tsx`

- [ ] **Step 1: Remove dead animation classes from SelectContent**

Old className (line 63):
```
bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 relative z-50 max-h-(--radix-select-content-available-height) min-w-[8rem] origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border shadow-md
```

New className (line 63):
```
"bg-popover text-popover-foreground relative z-50 max-h-(--radix-select-content-available-height) min-w-[8rem] origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border shadow-md"
```

### Task 6: Fix sheet.tsx

**Files:**
- Modify: `ui/src/components/ui/sheet.tsx`

- [ ] **Step 1: Remove dead animation classes from SheetOverlay**

Old className (line 39):
```
data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50
```

New className (line 39):
```
"fixed inset-0 z-50 bg-black/50"
```

- [ ] **Step 2: Remove dead animation classes from SheetContent**

Old content part (line 63):
```
bg-background data-[state=open]:animate-in data-[state=closed]:animate-out fixed z-50 flex flex-col gap-4 shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500
```

Remove `data-[state=open]:animate-in data-[state=closed]:animate-out` (keep `transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500` which ARE real Tailwind utilities).

New content part (line 63):
```
"bg-background fixed z-50 flex flex-col gap-4 shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500"
```

### Task 7: Typecheck and verify

- [ ] **Step 1: Run TypeScript typecheck**

Run: `cd /app/ui && pnpm typecheck`
Expected: No type errors (these are only className string changes — no type impact).

### Task 8: Commit

- [ ] **Step 1: Initialize git and commit**

```bash
cd /app
git init
git add -A
git commit -m "fix: remove dead animation classes from portal components, bump dropdown z-index

Non-existent Tailwind v4 animation utilities (animate-in, fade-in-0,
zoom-in-95, slide-in-from-*) were generating zero CSS rules across all
Radix UI portal wrappers. These dead classes misled debugging and
added noise to every portal component.

DropdownMenuContent z-index bumped from z-50 to z-[100] to ensure the
workspace switcher sits above all sibling z-50 portal layers (dialogs,
sheets, popovers, command palette) that can occlude it after navigation.

Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

### Task 9: Pull Request

- [ ] **Step 1: Create GitHub PR**

```bash
cd /app
gh pr create \
  --base master \
  --title "fix: broken workspace switcher dropdown after navigation" \
  --body "## Problem

Navigating to any page breaks the workspace switcher dropdown — its portaled content is invisible/too-low z-index.

## Root Cause

All Radix UI portal wrappers used non-existent Tailwind v4 animation utilities (\`animate-in\`, \`fade-in-0\`, \`zoom-in-95\`, \`slide-in-from-*\`) that generate zero CSS rules. After navigation, DOM re-ordering of sibling \`z-50\` portals could occlude the dropdown.

## Fix

1. Removed dead animation classes from all 6 portal components
2. Bumped DropdownMenuContent z-index to \`z-[100]\` to clear sibling portals

## Files Changed

- \`ui/src/components/ui/dropdown-menu.tsx\` — animation cleanup + z-index bump
- \`ui/src/components/ui/popover.tsx\` — animation cleanup
- \`ui/src/components/ui/dialog.tsx\` — animation cleanup
- \`ui/src/components/ui/tooltip.tsx\` — animation cleanup
- \`ui/src/components/ui/select.tsx\` — animation cleanup
- \`ui/src/components/ui/sheet.tsx\` — animation cleanup

Closes SUP-22"
```
