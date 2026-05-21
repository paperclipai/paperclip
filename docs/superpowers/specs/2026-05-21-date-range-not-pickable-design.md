# SUP-11 Date Range Not Pickable — Design Spec

**Date:** 2026-05-21  
**Issue:** SUP-11  
**Status:** Approved for implementation

## Problem

On the Costs page, when users select the **Custom** date-range preset, the two native `<input type="date">` fields do not allow date selection via the browser's calendar picker. Users can only type dates manually, which is error-prone and poor UX.

## Root Cause

The Costs page uses raw `<input type="date">` elements with ad-hoc Tailwind classes instead of the project's standard shadcn/ui `Input` component. Native date inputs are notoriously brittle across browsers and color schemes:

- The `::-webkit-calendar-picker-indicator` (calendar icon) can become invisible or unclickable when custom `background-color` and `color` values are applied, especially in dark mode.
- The inputs lack explicit sizing, focus rings, and accessibility attributes, making interaction unreliable.
- No validation prevents users from choosing an end date earlier than the start date.

## Solution

1. **Replace raw inputs with the shadcn/ui `Input` component** (`@/components/ui/input`) so the date fields inherit the project's tested, accessible form styling (focus rings, consistent height, proper disabled states).
2. **Add global CSS** in `ui/src/index.css` to ensure `::-webkit-calendar-picker-indicator` is always visible and clickable in both light and dark modes.
3. **Add `min` / `max` attributes** so the browser constrains the selectable range (end date ≥ start date, start date ≤ end date).
4. **Add `aria-label` attributes** for screen-reader context.

## Files to change

- `ui/src/pages/Costs.tsx`
- `ui/src/index.css`

## Verification

- Build passes (`pnpm typecheck` in `ui/`).
- The Custom date range section on `/costs` renders two inputs that open the browser calendar picker when clicked.
- Selecting a start date prevents the end-date picker from going earlier, and vice-versa.
