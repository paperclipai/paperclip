import { lazy, Suspense, useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { ExternalLink, X } from "lucide-react";
import { Link, useLocation, useNavigationType } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { SidePanelFrame, SidePanelToggleButton } from "@/components/side-panel";
import { PaperclipLoading } from "@/components/AnimatedPaperclipIcon";
import { BreadcrumbProvider, useBreadcrumbs } from "../context/BreadcrumbContext";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { hasBlockingShortcutDialog, isKeyboardShortcutTextInputTarget } from "../lib/keyboardShortcuts";
import { applyMainContentScrollTop, NavigationScrollMemory } from "../lib/navigation-scroll";

const TaskDetailSurface = lazy(() =>
  import("../pages/IssueDetail").then((module) => ({ default: module.TaskDetailSurface })),
);

export type TaskListSidePanelPresentation = "docked" | "overlay";

interface TaskListSidePanelProps {
  taskRef: string;
  onClose: () => void;
  presentation?: TaskListSidePanelPresentation;
}

interface TaskListSplitProps {
  taskRef: string | null;
  onClose: () => void;
  presentation?: TaskListSidePanelPresentation;
  children: ReactNode;
}

/**
 * A Tasks list beside its optional side panel. The list owns its scroll box
 * whenever the panel can open, so opening and closing the panel never moves
 * the list. An overlay panel covers the list instead of squashing it, and the
 * list keeps its scroll offset underneath.
 */
export function TaskListSplit({ taskRef, onClose, presentation = "docked", children }: TaskListSplitProps) {
  const listScrollRef = useRef<HTMLDivElement>(null);
  useListScrollMemory(listScrollRef);
  const covered = isTaskListCoveredByPanel(taskRef, presentation);
  return (
    <div data-testid="task-list-split" data-presentation={presentation} className="relative flex h-full min-h-0 md:-my-6 md:-mr-6">
      <div ref={listScrollRef} inert={covered} className="min-w-0 flex-1 overflow-auto md:py-6 md:pr-6">{children}</div>
      {taskRef ? <TaskListSidePanel taskRef={taskRef} onClose={onClose} presentation={presentation} /> : null}
    </div>
  );
}

/** An overlay covers the list, so the hidden rows leave the Tab order and ignore keys until the panel closes. */
export function isTaskListCoveredByPanel(taskRef: string | null, presentation: TaskListSidePanelPresentation): boolean {
  return taskRef !== null && presentation === "overlay";
}

/** The frame classes for each presentation; `sheet` fills the split, `docked` takes a fixed share beside the list. */
export function taskListSidePanelFrame(presentation: TaskListSidePanelPresentation): { presentation: "sheet" | "docked"; className: string } {
  if (presentation === "overlay") return { presentation: "sheet", className: "absolute inset-0 z-10" };
  return { presentation: "docked", className: "w-(--task-list-side-panel-width) shrink-0" };
}

/**
 * The task detail surface beside the Tasks list. Its own breadcrumb scope keeps
 * the task's title, toolbar and properties toggle out of the list page header.
 */
export function TaskListSidePanel({ taskRef, onClose, presentation = "docked" }: TaskListSidePanelProps) {
  const frameRef = useRef<HTMLElement>(null);
  const overlay = presentation === "overlay";
  useCloseOnEscape(onClose);
  useOverlayFocus(overlay, frameRef);
  const frame = taskListSidePanelFrame(presentation);
  return (
    <BreadcrumbProvider syncDocumentTitle={false}>
      <SidePanelFrame
        ref={frameRef}
        tabIndex={overlay ? -1 : undefined}
        label={`Task ${taskRef}`}
        contentMode="full-bleed"
        presentation={frame.presentation}
        className={frame.className}
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

/** Below the docked breakpoint, and on any touch pointer, the controls grow to the 44px size token. */
const TOUCH_CONTROL_CLASS = "max-lg:size-(--sz-44px) pointer-coarse:size-(--sz-44px)";

function TaskListSidePanelControls({ taskRef, onClose }: TaskListSidePanelProps) {
  const { breadcrumbPanelControl, breadcrumbToolbar } = useBreadcrumbs();
  return (
    <>
      {breadcrumbPanelControl ? (
        <SidePanelToggleButton open={breadcrumbPanelControl.open} onToggle={breadcrumbPanelControl.onToggle} className={TOUCH_CONTROL_CLASS} />
      ) : breadcrumbToolbar}
      <Button asChild variant="ghost" size="icon-sm" className={TOUCH_CONTROL_CLASS} title="Open full page">
        <Link to={createIssueDetailPath(taskRef)} disableIssueQuicklook aria-label="Open full page">
          <ExternalLink aria-hidden />
        </Link>
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" className={TOUCH_CONTROL_CLASS} onClick={onClose} aria-label="Close task panel" title="Close (Esc)">
        <X aria-hidden />
      </Button>
    </>
  );
}

const listScrollMemory = new NavigationScrollMemory();

/** Layout restores only the page scroll on Back, so the list's own scroll box keeps its offset here. */
function useListScrollMemory(scrollRef: RefObject<HTMLElement | null>) {
  const location = useLocation();
  const navigationType = useNavigationType();
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const recordScroll = () => listScrollMemory.remember(location.key, element.scrollTop);
    element.addEventListener("scroll", recordScroll, { passive: true });
    return () => element.removeEventListener("scroll", recordScroll);
  }, [location.key, scrollRef]);
  useLayoutEffect(() => {
    if (navigationType !== "POP") return;
    const scrollTop = listScrollMemory.recall(location.key);
    applyMainContentScrollTop(scrollRef.current, scrollTop);
    const raf = requestAnimationFrame(() => applyMainContentScrollTop(scrollRef.current, scrollTop));
    return () => cancelAnimationFrame(raf);
  }, [location.key, navigationType, scrollRef]);
}

/** The overlay takes focus like a modal sheet, and gives it back to the covered list control when it closes. */
function useOverlayFocus(active: boolean, frameRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement;
    frameRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [active, frameRef]);
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
