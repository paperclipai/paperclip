import { lazy, Suspense, useEffect } from "react";
import { ExternalLink, X } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { SidePanelFrame, SidePanelToggleButton } from "@/components/side-panel";
import { PaperclipLoading } from "@/components/AnimatedPaperclipIcon";
import { BreadcrumbProvider, useBreadcrumbs } from "../context/BreadcrumbContext";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { hasBlockingShortcutDialog, isKeyboardShortcutTextInputTarget } from "../lib/keyboardShortcuts";

const TaskDetailSurface = lazy(() =>
  import("../pages/IssueDetail").then((module) => ({ default: module.TaskDetailSurface })),
);

interface TaskListSidePanelProps {
  taskRef: string;
  onClose: () => void;
}

/**
 * The task detail surface beside the Tasks list. Its own breadcrumb scope keeps
 * the task's title, toolbar and properties toggle out of the list page header.
 */
export function TaskListSidePanel({ taskRef, onClose }: TaskListSidePanelProps) {
  useCloseOnEscape(onClose);
  return (
    <BreadcrumbProvider syncDocumentTitle={false}>
      <SidePanelFrame
        label={`Task ${taskRef}`}
        contentMode="full-bleed"
        className="w-(--task-list-side-panel-width) shrink-0"
        bodyClassName="flex flex-col overflow-auto"
        header={<TaskListSidePanelTitle taskRef={taskRef} />}
        trailingControls={<TaskListSidePanelControls taskRef={taskRef} onClose={onClose} />}
      >
        <Suspense fallback={<PaperclipLoading />}>
          <TaskDetailSurface embeddedIssueRef={taskRef} />
        </Suspense>
      </SidePanelFrame>
    </BreadcrumbProvider>
  );
}

function TaskListSidePanelTitle({ taskRef }: { taskRef: string }) {
  const { breadcrumbs } = useBreadcrumbs();
  const current = breadcrumbs.at(-1);
  return (
    <div className="flex min-w-0 items-center gap-2 px-2 text-sm">
      {current?.leading}
      <span className="shrink-0 font-mono text-muted-foreground">{current?.identifier ?? taskRef}</span>
      {current ? <span className="truncate font-medium">{current.label}</span> : null}
    </div>
  );
}

function TaskListSidePanelControls({ taskRef, onClose }: TaskListSidePanelProps) {
  const { breadcrumbPanelControl } = useBreadcrumbs();
  return (
    <>
      {breadcrumbPanelControl ? (
        <SidePanelToggleButton open={breadcrumbPanelControl.open} onToggle={breadcrumbPanelControl.onToggle} />
      ) : null}
      <Button asChild variant="ghost" size="icon-sm" title="Open full page">
        <Link to={createIssueDetailPath(taskRef)} disableIssueQuicklook aria-label="Open full page">
          <ExternalLink aria-hidden />
        </Link>
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close task panel" title="Close (Esc)">
        <X aria-hidden />
      </Button>
    </>
  );
}

function useCloseOnEscape(onClose: () => void) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTaskListSidePanelCloseKey(event)) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);
}

/** Esc closes the panel unless a dialog, a text field or another handler owns the key. */
export function isTaskListSidePanelCloseKey(event: Pick<KeyboardEvent, "key" | "defaultPrevented" | "target">): boolean {
  return event.key === "Escape"
    && !event.defaultPrevented
    && !hasBlockingShortcutDialog(document)
    && !isKeyboardShortcutTextInputTarget(event.target);
}
