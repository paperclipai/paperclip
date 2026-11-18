import type { Issue } from "@paperclipai/shared";

/** Search param that keeps the task open in the Tasks list side panel, e.g. `?task=PAP-123`. */
export const TASK_LIST_SIDE_PANEL_PARAM = "task";

interface ClickLike {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

/** Only a plain primary click opens the side panel; modified clicks keep the browser's new-tab behavior. */
export function shouldOpenTaskInSidePanel(event: ClickLike): boolean {
  return !event.defaultPrevented
    && event.button === 0
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && !event.altKey;
}

/** The list row to highlight for the open task; the param may hold an identifier or an id. */
export function findIssueByRef(issues: readonly Issue[], taskRef: string | null): Issue | undefined {
  if (!taskRef) return undefined;
  return issues.find((issue) => issue.identifier === taskRef || issue.id === taskRef);
}

export function readSidePanelTaskRef(searchParams: URLSearchParams): string | null {
  const value = searchParams.get(TASK_LIST_SIDE_PANEL_PARAM)?.trim();
  return value ? value : null;
}

/** Keeps every other list param (view, filters, sort, search) so the list does not change under the panel. */
export function withSidePanelTaskRef(searchParams: URLSearchParams, taskRef: string | null): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  if (taskRef) next.set(TASK_LIST_SIDE_PANEL_PARAM, taskRef);
  else next.delete(TASK_LIST_SIDE_PANEL_PARAM);
  return next;
}
