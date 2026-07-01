# Issues Page Empty State UI

> Date: 2026-05-20
> Scope: UI only (`ui/src/pages/Issues.tsx`, `ui/src/components/EmptyState.tsx`)

## Goal

Add an empty-state UI to the Issues page that displays when a company is selected but no issues exist. This improves the user experience by providing clear guidance instead of rendering an empty list.

---

## Changes

### 1. Extended `EmptyState` Component

**File:** `ui/src/components/EmptyState.tsx`

The existing `EmptyState` component only supported a single `message` prop. It was extended to optionally accept `title` and `description` props while maintaining **full backward compatibility** with existing usages.

**Props Added:**

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `title` | `string` | No | Bold heading text rendered above the description |
| `description` | `string` | No | Secondary muted text providing context |

**Behavior:**
- When `description` is provided, the legacy `message` prop is suppressed to avoid duplication.
- When only `message` is provided (legacy usage), it renders exactly as before.
- The `action` / `onAction` button behavior is unchanged.

**Styling:**
- Title: `text-base font-medium` — consistent with UI heading patterns
- Description: `text-sm text-muted-foreground` — matches existing muted text styling

---

### 2. Issues Page Empty-State Rendering

**File:** `ui/src/pages/Issues.tsx`

Added a conditional render block after the "no company selected" guard and before the `IssuesList` render.

**Condition:**
```tsx
if (!isLoading && issues.length === 0) {
  return (
    <EmptyState
      icon={CircleDot}
      title="No issues yet"
      description="Create your first issue to start tracking work."
    />
  );
}
```

**Logic:**
- Only renders when a `selectedCompanyId` exists (handled by prior guard)
- Waits for loading to complete (`!isLoading`) to avoid flashing empty state during data fetch
- Uses the existing `CircleDot` icon already imported in the file
- Uses the existing `EmptyState` component already imported in the file

---

## Files Modified

| File | Change Type | Description |
|------|-------------|-------------|
| `ui/src/components/EmptyState.tsx` | Modify | Added optional `title` and `description` props with backward-compatible rendering logic |
| `ui/src/pages/Issues.tsx` | Modify | Added empty-state conditional render when `!isLoading && issues.length === 0` |

---

## Verification

1. **Typecheck:** Run `pnpm -r typecheck` to ensure no TypeScript errors from prop changes.
2. **Visual Check:**
   - Navigate to Issues page with a company that has no issues → should show empty state with title and description.
   - Navigate to Issues page while loading → should show loading state (no empty state flash).
   - Navigate to Issues page with existing issues → should render `IssuesList` as before.
   - Verify other pages using `EmptyState` with only `message` still render correctly.

---

## Risks

| Risk | Mitigation |
|------|------------|
| Empty state flashes briefly before data loads | Guarded by `!isLoading` check |
| Breaking existing `EmptyState` usages | `message` prop still supported; `description` takes precedence only when explicitly provided |
| Styling inconsistency | Title and description use existing Tailwind utility patterns (`font-medium`, `text-muted-foreground`) |

---

## Backward Compatibility

All existing `EmptyState` usages with `message` continue to work identically. No call sites were broken by this change.
