# SUP-11 Date Range Not Pickable — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the custom date-range picker on the Costs page so users can pick dates via the browser calendar widget.

**Architecture:** Replace raw `<input type="date">` with the shadcn/ui `Input` component, add global CSS for the WebKit calendar-picker indicator, and add min/max range validation.

**Tech Stack:** React 19, Tailwind CSS v4, shadcn/ui

---

### Task 1: Add global CSS for date-input calendar indicator

**Files:**
- Modify: `ui/src/index.css`

- [ ] **Step 1: Append calendar-indicator styles to index.css**

  Add the following rule near the end of the file (before any `@media` blocks or after the existing utility classes):

  ```css
  /* Ensure native date-input calendar icon is visible in light and dark modes */
  input[type="date"]::-webkit-calendar-picker-indicator {
    opacity: 1;
    cursor: pointer;
  }
  ```

- [ ] **Step 2: Verify the file still builds**

  Run: `cd /app/ui && pnpm typecheck`
  Expected: no errors

---

### Task 2: Replace raw date inputs in Costs.tsx

**Files:**
- Modify: `ui/src/pages/Costs.tsx`
- Test: existing e2e / visual tests (no new unit tests required for this UI-only fix)

- [ ] **Step 1: Import the shadcn/ui Input component**

  Add to the existing imports at the top of `ui/src/pages/Costs.tsx`:

  ```tsx
  import { Input } from "@/components/ui/input";
  ```

- [ ] **Step 2: Replace the raw `<input type="date">` elements**

  Locate the block inside `preset === "custom"` (around line 564). Replace:

  ```tsx
  {preset === "custom" ? (
    <div className="flex flex-wrap items-center gap-2 border border-border p-3">
      <input
        type="date"
        value={customFrom}
        onChange={(event) => setCustomFrom(event.target.value)}
        className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
      />
      <span className="text-sm text-muted-foreground">to</span>
      <input
        type="date"
        value={customTo}
        onChange={(event) => setCustomTo(event.target.value)}
        className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
      />
    </div>
  ) : null}
  ```

  with:

  ```tsx
  {preset === "custom" ? (
    <div className="flex flex-wrap items-center gap-2 border border-border p-3">
      <Input
        type="date"
        value={customFrom}
        onChange={(event) => setCustomFrom(event.target.value)}
        max={customTo || undefined}
        aria-label="Start date"
        className="w-auto min-w-[140px]"
      />
      <span className="text-sm text-muted-foreground">to</span>
      <Input
        type="date"
        value={customTo}
        onChange={(event) => setCustomTo(event.target.value)}
        min={customFrom || undefined}
        aria-label="End date"
        className="w-auto min-w-[140px]"
      />
    </div>
  ) : null}
  ```

- [ ] **Step 3: Run typecheck**

  Run: `cd /app/ui && pnpm typecheck`
  Expected: no errors

---

### Task 3: Commit and open PR

- [ ] **Step 1: Stage changes**

  ```bash
  git add ui/src/pages/Costs.tsx ui/src/index.css
  ```

- [ ] **Step 2: Commit**

  ```bash
  git commit -m "fix(ui): make custom date range pickable on Costs page

- Replace raw <input type=date> with shadcn/ui Input component
- Add global CSS to ensure calendar picker indicator is visible
- Add min/max validation and aria-labels for accessibility

Fixes SUP-11

Co-Authored-By: Paperclip <noreply@paperclip.ing>"
  ```

- [ ] **Step 3: Push branch and open PR**

  Push to a branch named `fix/SUP-11-date-range-not-pickable` and open a PR against `master` using the template in `.github/PULL_REQUEST_TEMPLATE.md`.
