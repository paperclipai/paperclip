# Broken Workspace Switcher (Bank Account Chooser) — Design Spec

## Problem

Navigating to any page in the Paperclip app breaks the workspace switcher dropdown (SidebarCompanyMenu). After navigation, clicking the trigger opens the dropdown but its portaled content is invisible or has an insufficient z-index, making it unclickable.

## Root Cause Analysis

1. **Dead animation classes**: The DropdownMenuContent, PopoverContent, and other portal components use non-existent Tailwind CSS v4 animation utilities (`animate-in`, `fade-in-0`, `zoom-in-95`, `slide-in-from-top-2`, etc.). These classes are not defined anywhere in the project — they are not built into Tailwind v4, no `tailwindcss-animate` plugin is installed, and no custom `@utility` defines them. They generate zero CSS rules and are entirely dead code that misleads debugging.

2. **z-index collision**: All Radix UI portal components (dropdowns, popovers, dialogs, sheets, tooltips) render at `z-50` in `document.body`. After navigation, DOM structure changes can cause portal content ordering shifts. The workspace switcher dropdown can be positioned behind sibling portals (e.g., command palette, property panel sheet) that share the same z-index layer.

## Solution

### Approach A (Recommended): Remove dead animations + increase z-index

**Part 1 — Remove broken animation classes from all portal components:**
- `dropdown-menu.tsx`: Strip `animate-in`, `fade-in-0`, `zoom-in-95`, `slide-in-from-*` from `DropdownMenuContent` and `DropdownMenuSubContent`
- `popover.tsx`: Same treatment for `PopoverContent`
- `dialog.tsx`: Same treatment for overlay and content
- `tooltip.tsx`: Same treatment for `TooltipContent`
- `select.tsx`: Same treatment for `SelectContent`
- `sheet.tsx`: Same treatment for overlay and content

These classes have zero CSS effect — removing them changes no visible behavior and eliminates misleading dead code.

**Part 2 — Increase z-index on dropdown content:**
- Change `z-50` to `z-[100]` on `DropdownMenuContent` in `dropdown-menu.tsx`
- This elevates workspace switcher content above all other `z-50` portal layers (dialogs, sheets, popovers, command palette)

### Why not Approach B (Install tailwindcss-animate)

Adding `tailwindcss-animate` would make the dead animation classes work, but:
- Adds a dependency for purely cosmetic animation sugar
- Doesn't fix the actual z-index issue
- Animations could introduce race conditions with portal rendering

### Why not Approach C (Custom CSS keyframes)

Defining keyframes manually adds maintenance burden for cosmetic effects that provide minimal UX value in a business tool.

## Scope

**Files to modify:**
- `ui/src/components/ui/dropdown-menu.tsx` — animation classes + z-index
- `ui/src/components/ui/popover.tsx` — animation classes
- `ui/src/components/ui/dialog.tsx` — animation classes
- `ui/src/components/ui/tooltip.tsx` — animation classes
- `ui/src/components/ui/select.tsx` — animation classes
- `ui/src/components/ui/sheet.tsx` — animation classes

**No new files.** No new dependencies. No CSS changes outside these components.
