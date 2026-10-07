import type { SavedTaskView } from "@paperclipai/shared";
import { defaultIssueFilterState } from "./issue-filters";

/**
 * Saved task views — the user-defined half of the Tasks view registry.
 *
 * The built-in views in `task-views.ts` are fixed slices every instance has.
 * A saved view is the same idea, defined by the user: apply the normal
 * filters, name the result, come back to it later from the same Views menu.
 *
 * A saved view is a *definition*, never a copy of the rows: the filters, sort,
 * grouping, and display options needed to rebuild the list. Opening one re-runs
 * the normal task query, so the task list stays the only source of truth and a
 * view's contents follow task state as it changes.
 *
 * What is generic lives here — how a definition is extracted, compared, and
 * applied. What a definition *means* stays with the list that applies it.
 */

/** A saved view is addressed in the URL as `?view=saved:<id>`. */
export const SAVED_TASK_VIEW_PREFIX = "saved:";

export type SavedTaskViewKey = `saved:${string}`;

export function savedTaskViewKey(id: string): SavedTaskViewKey {
  return `${SAVED_TASK_VIEW_PREFIX}${id}`;
}

export function isSavedTaskViewKey(value: unknown): value is SavedTaskViewKey {
  return typeof value === "string"
    && value.startsWith(SAVED_TASK_VIEW_PREFIX)
    && value.length > SAVED_TASK_VIEW_PREFIX.length;
}

/** Returns the view id in a `saved:<id>` key, or `null` for any other value. */
export function parseSavedTaskViewId(value: unknown): string | null {
  return isSavedTaskViewKey(value) ? value.slice(SAVED_TASK_VIEW_PREFIX.length) : null;
}

export function findSavedTaskView(
  views: readonly SavedTaskView[] | undefined,
  key: string | null | undefined,
): SavedTaskView | null {
  const id = parseSavedTaskViewId(key);
  if (!id) return null;
  return views?.find((view) => view.id === id) ?? null;
}

/**
 * View-state keys that describe *where you are* rather than *what the view
 * is*: which groups and parents you happen to have folded shut. They are
 * per-session noise, so they stay out of the stored definition and out of the
 * unsaved-changes comparison — folding a group must not make a view look
 * edited.
 */
export const EPHEMERAL_VIEW_STATE_KEYS = ["collapsedGroups", "collapsedParents"] as const;

/** Strips the ephemeral keys, so what is stored is only the definition. */
export function toSavedViewDefinition(
  viewState: Record<string, unknown>,
): Record<string, unknown> {
  const definition: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(viewState)) {
    if ((EPHEMERAL_VIEW_STATE_KEYS as readonly string[]).includes(key)) continue;
    definition[key] = value;
  }
  return definition;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Compares two definitions by value. Filter arrays are order-insensitive:
 * picking "todo" then "backlog" is the same view as picking them the other way
 * round, and the unsaved-changes indicator must not claim otherwise.
 */
export function savedViewDefinitionsEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const left = toSavedViewDefinition(a);
  const right = toSavedViewDefinition(b);
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const leftValue = left[key];
    const rightValue = right[key];
    if (Array.isArray(leftValue) && Array.isArray(rightValue)) {
      if (leftValue.length !== rightValue.length) return false;
      const sortedLeft = leftValue.map(stableStringify).sort();
      const sortedRight = rightValue.map(stableStringify).sort();
      if (sortedLeft.some((entry, index) => entry !== sortedRight[index])) return false;
      continue;
    }
    if (stableStringify(leftValue) !== stableStringify(rightValue)) return false;
  }
  return true;
}

/**
 * A short stand-in for a definition's *content*, so a surface can tell whether
 * the stored view has actually changed shape.
 *
 * Deliberately not `updatedAt`: renaming a view bumps that timestamp without
 * touching a single filter, and a consumer keyed on the timestamp would throw
 * away filter edits the user had not saved yet. Two definitions that
 * `savedViewDefinitionsEqual` calls equal share a revision.
 */
export function savedViewDefinitionRevision(definition: Record<string, unknown>): string {
  const canonical: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(toSavedViewDefinition(definition))) {
    canonical[key] = Array.isArray(value) ? value.map(stableStringify).sort() : value;
  }
  return stableStringify(canonical);
}

/**
 * Builds the view state to open a saved view with. The ephemeral keys carry
 * over from the current state, so switching views does not re-expand
 * everything the user folded; the collection's own normalizer decides what the
 * stored definition's keys mean and drops any it no longer recognizes.
 */
export function applySavedViewDefinition<T extends Record<string, unknown>>(
  current: T,
  definition: Record<string, unknown>,
  normalize: (value: unknown) => T,
): T {
  const carried: Record<string, unknown> = {};
  for (const key of EPHEMERAL_VIEW_STATE_KEYS) {
    if (key in current) carried[key] = current[key];
  }
  return normalize({ ...toSavedViewDefinition(definition), ...carried });
}

/** Suggests "Copy of X", "Copy of X 2", … skipping names already in use. */
export function suggestSavedViewCopyName(
  views: readonly SavedTaskView[],
  baseName: string,
  maxLength = 60,
): string {
  const taken = new Set(views.map((view) => view.name.trim().toLocaleLowerCase()));
  const base = `Copy of ${baseName}`.slice(0, maxLength);
  if (!taken.has(base.trim().toLocaleLowerCase())) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base.slice(0, maxLength - String(suffix).length - 1)} ${suffix}`;
    if (!taken.has(candidate.trim().toLocaleLowerCase())) return candidate;
  }
  return base;
}

/* ── Starter views ── */

export type StarterTaskView = {
  name: string;
  /** Partial task-list view state; the collection normalizes the rest. */
  definition: Record<string, unknown>;
};

/**
 * Offered to a collection that has no saved views yet, behind an explicit
 * "Add starter views". They are created as ordinary saved views, so
 * they can be renamed, re-filtered, reordered, or deleted like any other, and
 * declining leaves no rows behind.
 *
 * Nothing here is instance-specific: these are slices of a task list that any
 * Paperclip user has. An instance that wants different defaults changes its
 * own saved views, not this list.
 *
 * Attention is deliberately absent. Paperclip already ranks what needs a
 * person on its own surface, and that ranking is not expressible as a filter
 * — reproducing it here would be a second implementation of the same rule.
 */
export const STARTER_SAVED_TASK_VIEWS: readonly StarterTaskView[] = [
  {
    name: "Ready to start",
    definition: {
      ...defaultIssueFilterState,
      statuses: ["todo", "backlog"],
      hideRoutineExecutions: true,
      sortField: "priority",
      sortDir: "asc",
      groupBy: "status",
      viewMode: "list",
    },
  },
  {
    name: "Active",
    definition: {
      ...defaultIssueFilterState,
      statuses: ["in_progress"],
      hideRoutineExecutions: true,
      sortField: "updated",
      sortDir: "desc",
      groupBy: "none",
      viewMode: "list",
    },
  },
  {
    name: "Waiting on agents",
    definition: {
      ...defaultIssueFilterState,
      statuses: ["in_progress"],
      liveOnly: true,
      sortField: "updated",
      sortDir: "desc",
      groupBy: "assignee",
      viewMode: "list",
    },
  },
  {
    name: "Needs me",
    definition: {
      ...defaultIssueFilterState,
      assignees: ["__me"],
      statuses: ["todo", "in_progress", "in_review", "blocked"],
      hideRoutineExecutions: true,
      sortField: "priority",
      sortDir: "asc",
      groupBy: "status",
      viewMode: "list",
    },
  },
  {
    name: "In review",
    definition: {
      ...defaultIssueFilterState,
      statuses: ["in_review"],
      sortField: "updated",
      sortDir: "desc",
      groupBy: "none",
      viewMode: "list",
    },
  },
  {
    name: "Blocked",
    definition: {
      ...defaultIssueFilterState,
      statuses: ["blocked"],
      sortField: "updated",
      sortDir: "desc",
      groupBy: "none",
      viewMode: "list",
    },
  },
  {
    name: "Done",
    definition: {
      ...defaultIssueFilterState,
      statuses: ["done", "cancelled"],
      hideRoutineExecutions: true,
      sortField: "updated",
      sortDir: "desc",
      groupBy: "none",
      viewMode: "list",
    },
  },
];

function savedViewNameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/**
 * The starter views this list does not already hold, in their listed order.
 *
 * Creating the set is one write per view, so a run can stop part way. Both the
 * creating hook and the menu that offers the action work from this, so a
 * second attempt creates exactly the views the first one missed.
 */
export function missingStarterTaskViews(
  views: readonly SavedTaskView[] | undefined,
): readonly StarterTaskView[] {
  const taken = new Set((views ?? []).map((view) => savedViewNameKey(view.name)));
  return STARTER_SAVED_TASK_VIEWS.filter((starter) => !taken.has(savedViewNameKey(starter.name)));
}

/**
 * Whether the Views menu should offer "Add starter views".
 *
 * Two cases: the collection is empty, which is the first-run offer; or it
 * holds some starters but not all, which is how a half-finished run looks from
 * the outside. Without the second case a user whose set stopped at three of
 * seven has no way to ask for the rest.
 */
export function shouldOfferStarterTaskViews(
  views: readonly SavedTaskView[] | undefined,
): boolean {
  const missing = missingStarterTaskViews(views);
  if (missing.length === 0) return false;
  return (views?.length ?? 0) === 0 || missing.length < STARTER_SAVED_TASK_VIEWS.length;
}
