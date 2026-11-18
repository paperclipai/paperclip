import { useCallback } from "react";
import type { Issue } from "@paperclipai/shared";
import { useIsMobileViewport } from "@/context/SidebarContext";
import { useSearchParams } from "@/lib/router";
import { readSidePanelTaskRef, withSidePanelTaskRef } from "@/lib/task-list-side-panel";
import { useTaskListSidePanelEnabled } from "./useTaskListSidePanelEnabled";

export interface TaskListSidePanelState {
  /** The flag is on and the viewport is not mobile; mobile keeps the full task page. */
  enabled: boolean;
  /** The task kept open by the `task` search param, or null when the panel is closed. */
  taskRef: string | null;
  openIssue: (issue: Issue) => void;
  close: () => void;
}

/**
 * Side panel state shared by every Tasks list surface. The open task lives in
 * the URL so a reload or a shared link reopens it beside the same list.
 */
export function useTaskListSidePanel(adjustParams?: (next: URLSearchParams) => void): TaskListSidePanelState {
  const isMobile = useIsMobileViewport();
  const { enabled: flagEnabled } = useTaskListSidePanelEnabled();
  const [searchParams, setSearchParams] = useSearchParams();
  const enabled = flagEnabled && !isMobile;
  const taskRef = enabled ? readSidePanelTaskRef(searchParams) : null;
  const showTask = useCallback((next: string | null) => {
    setSearchParams(current => {
      const params = withSidePanelTaskRef(current, next);
      adjustParams?.(params);
      return params;
    });
  }, [setSearchParams, adjustParams]);
  const openIssue = useCallback((issue: Issue) => showTask(issue.identifier ?? issue.id), [showTask]);
  const close = useCallback(() => showTask(null), [showTask]);
  return { enabled, taskRef, openIssue, close };
}
