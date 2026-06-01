/**
 * Pure selection helpers backing the multi-select UI in `IssuesList`.
 * Extracted from the component so the range/anchor semantics can be unit
 * tested without rendering React.
 */

export interface SelectionState {
  selectedIds: ReadonlySet<string>;
  anchorId: string | null;
}

const EMPTY_SELECTION: SelectionState = { selectedIds: new Set(), anchorId: null };

export function emptySelection(): SelectionState {
  return { selectedIds: new Set(EMPTY_SELECTION.selectedIds), anchorId: null };
}

/**
 * Returns the next selection state after a click on `issueId`.
 *
 * - Plain click toggles the id and resets the anchor to it.
 * - Shift-click adds every id in the rendered range `[anchor, issueId]` to the
 *   selection (additive — does not remove existing selections), then moves the
 *   anchor to `issueId`. If there is no anchor, or either endpoint is missing
 *   from `renderedOrder` (e.g., became invisible after a filter change), it
 *   falls back to a plain toggle.
 *
 * `renderedOrder` must reflect the on-screen DFS order (use
 * `buildRenderedIssueOrder` from `issue-tree`); the flat-filtered order can
 * diverge from the rendered order whenever nesting interleaves parents and
 * children of other parents.
 */
export function toggleIssueSelection(
  state: SelectionState,
  issueId: string,
  shiftKey: boolean,
  renderedOrder: readonly string[],
): SelectionState {
  if (shiftKey && state.anchorId) {
    const anchorIdx = renderedOrder.indexOf(state.anchorId);
    const targetIdx = renderedOrder.indexOf(issueId);
    if (anchorIdx !== -1 && targetIdx !== -1) {
      const [start, end] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
      const next = new Set(state.selectedIds);
      for (let i = start; i <= end; i++) next.add(renderedOrder[i]!);
      return { selectedIds: next, anchorId: issueId };
    }
  }
  const next = new Set(state.selectedIds);
  if (next.has(issueId)) next.delete(issueId);
  else next.add(issueId);
  return { selectedIds: next, anchorId: issueId };
}

export interface BatchUpdateResult {
  id: string;
  success: boolean;
  error?: string;
}

export interface BatchOutcome {
  failedIds: string[];
  firstError?: string;
  succeededCount: number;
  totalRequested: number;
}

/**
 * Reconciles a `/issues/batch` response against the requested ids. Any
 * requested id that does not appear in `results` is treated as a failure so we
 * never silently drop entries the server forgot to echo back.
 */
export function summarizeBatchOutcome(
  requestedIds: readonly string[],
  results: readonly BatchUpdateResult[] | undefined,
): BatchOutcome {
  const failedIds: string[] = [];
  let firstError: string | undefined;
  const reported = new Set<string>();
  for (const result of results ?? []) {
    reported.add(result.id);
    if (!result.success) {
      failedIds.push(result.id);
      if (!firstError && result.error) firstError = result.error;
    }
  }
  for (const id of requestedIds) {
    if (!reported.has(id)) failedIds.push(id);
  }
  const failedSet = new Set(failedIds);
  return {
    failedIds: [...failedSet],
    firstError,
    succeededCount: requestedIds.length - failedSet.size,
    totalRequested: requestedIds.length,
  };
}
