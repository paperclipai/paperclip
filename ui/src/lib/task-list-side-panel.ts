import type { Issue } from "@paperclipai/shared";

/** Search param that keeps the task open in the Tasks list side panel, e.g. `?task=PAP-123`. */
export const TASK_LIST_SIDE_PANEL_PARAM = "task";

/** Below this width the Tasks list is the mobile shell, and a task opens its full page. */
export const TASK_LIST_SIDE_PANEL_FULL_PAGE_BELOW = 768;
/** Below this width the docked panel would squash the list, so it covers the list instead. */
export const TASK_LIST_SIDE_PANEL_DOCKED_FROM = 1024;

export type TaskListSidePanelPresentation = "full-page" | "overlay" | "docked";

/** Phones keep the full task page; tablets get a full-width overlay; wider viewports dock the panel beside the list. */
export function resolveTaskListSidePanelPresentation(viewportWidth: number): TaskListSidePanelPresentation {
  if (viewportWidth < TASK_LIST_SIDE_PANEL_FULL_PAGE_BELOW) return "full-page";
  if (viewportWidth < TASK_LIST_SIDE_PANEL_DOCKED_FROM) return "overlay";
  return "docked";
}

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

/** The chat shell pulls itself out to the page gutters; an embedded surface has none, so it must not. */
export function taskChatShellLayoutClass(input: { isMobile: boolean; streamlined: boolean; embedded: boolean }): string {
  const fill = input.isMobile && !input.embedded;
  if (input.streamlined || input.embedded) return fill ? "flex min-h-0 flex-1 flex-col" : "flex min-h-0 flex-col";
  if (fill) return "-mx-4 flex min-h-0 flex-1 flex-col";
  return "-mx-4 -mt-4 md:-mx-6 md:-mt-6 flex min-h-0 flex-col";
}
