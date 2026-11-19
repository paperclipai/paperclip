import { useCallback, useEffect, useState } from "react";
import type { Issue } from "@paperclipai/shared";
import { useNavigate, useSearchParams } from "@/lib/router";
import { createIssueDetailPath } from "@/lib/issueDetailBreadcrumb";
import {
  readSidePanelTaskRef,
  resolveTaskListSidePanelPresentation,
  withSidePanelTaskRef,
  type TaskListSidePanelPresentation,
} from "@/lib/task-list-side-panel";
import { useTaskListSidePanelEnabled } from "./useTaskListSidePanelEnabled";

export interface TaskListSidePanelState {
  /** The flag is on and the viewport is not a phone; a phone keeps the full task page. */
  enabled: boolean;
  /** How the open task is shown: docked beside the list, or as an overlay that covers the list. */
  presentation: Exclude<TaskListSidePanelPresentation, "full-page">;
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
  const viewport = useTaskListSidePanelPresentation();
  const { enabled: flagEnabled } = useTaskListSidePanelEnabled();
  const [searchParams, setSearchParams] = useSearchParams();
  const enabled = flagEnabled && viewport !== "full-page";
  const presentation = viewport === "overlay" ? "overlay" : "docked";
  const taskRef = enabled ? readSidePanelTaskRef(searchParams) : null;
  useOpenSharedTaskOnPhone(flagEnabled && viewport === "full-page" ? readSidePanelTaskRef(searchParams) : null);
  const showTask = useCallback((next: string | null) => {
    setSearchParams(current => {
      const params = withSidePanelTaskRef(current, next);
      adjustParams?.(params);
      return params;
    });
  }, [setSearchParams, adjustParams]);
  const openIssue = useCallback((issue: Issue) => showTask(issue.identifier ?? issue.id), [showTask]);
  const close = useCallback(() => showTask(null), [showTask]);
  return { enabled, presentation, taskRef, openIssue, close };
}

/** A shared `?task=` link on a phone has no panel, so it opens the task's full page. */
function useOpenSharedTaskOnPhone(taskRef: string | null): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (taskRef) navigate(createIssueDetailPath(taskRef), { replace: true });
  }, [taskRef, navigate]);
}

/** The presentation for the current viewport width; it follows window resizes and device rotation. */
export function useTaskListSidePanelPresentation(): TaskListSidePanelPresentation {
  const [presentation, setPresentation] = useState(() => resolveTaskListSidePanelPresentation(window.innerWidth));
  useEffect(() => {
    const update = () => setPresentation(resolveTaskListSidePanelPresentation(window.innerWidth));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return presentation;
}
