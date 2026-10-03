import { createContext, useContext, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export type TaskChatViewMode = "full" | "focus";

export const TASK_CHAT_VIEW_MODE_STORAGE_KEY = "paperclip.task-chat.view-mode.v1";

export function readTaskChatViewMode(): TaskChatViewMode {
  try {
    return localStorage.getItem(TASK_CHAT_VIEW_MODE_STORAGE_KEY) === "focus"
      ? "focus"
      : "full";
  } catch {
    // Private browsing/storage limits: keep the full view.
    return "full";
  }
}

export function saveTaskChatViewMode(mode: TaskChatViewMode) {
  try {
    localStorage.setItem(TASK_CHAT_VIEW_MODE_STORAGE_KEY, mode);
  } catch { /* Storage unavailable: the choice lasts for this visit only. */ }
}

// Isolated previews/tests keep the full timeline unless they opt in.
const TaskChatViewModeContext = createContext<TaskChatViewMode>("full");

export function TaskChatViewModeProvider({
  mode,
  children,
}: {
  mode: TaskChatViewMode;
  children: ReactNode;
}) {
  return (
    <TaskChatViewModeContext.Provider value={mode}>
      {children}
    </TaskChatViewModeContext.Provider>
  );
}

export function useTaskChatFocusMode(): boolean {
  return useContext(TaskChatViewModeContext) === "focus";
}

/**
 * Rows that Focus view never folds: runtime requests can wait for an operator
 * decision, and plan documents are durable artifacts rather than runner noise.
 */
export function isTaskChatFocusPersistentRow(row: {
  kind: string;
  surface?: string;
}): boolean {
  return (
    row.kind === "plan_document" ||
    (row.kind === "protocol" && row.surface === "runtime_request")
  );
}

const VIEW_MODE_OPTIONS: { mode: TaskChatViewMode; label: string }[] = [
  { mode: "full", label: "Full view" },
  { mode: "focus", label: "Focus view" },
];

export function TaskChatViewModeToggle({
  mode,
  onChange,
}: {
  mode: TaskChatViewMode;
  onChange: (mode: TaskChatViewMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Thread view"
      className="flex items-center justify-end gap-1 text-xs text-muted-foreground"
      data-testid="task-chat-view-mode-toggle"
    >
      {VIEW_MODE_OPTIONS.map((option) => (
        <button
          key={option.mode}
          type="button"
          aria-pressed={mode === option.mode}
          className={cn(
            "rounded-sm px-2 py-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            mode === option.mode && "bg-muted text-foreground",
          )}
          onClick={() => onChange(option.mode)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Focus view folds a turn's intermediate runner rows into one keyboard
 * accessible line. Full view renders them unchanged.
 */
export function TaskChatFocusFold({
  stepCount,
  children,
}: {
  stepCount: number;
  children: ReactNode;
}) {
  const focus = useTaskChatFocusMode();
  const [open, setOpen] = useState(false);
  if (!focus || stepCount === 0) return <>{children}</>;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="task-chat-focus-fold">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-fit items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3 transition-transform", open && "rotate-90")}
        />
        {stepCount} {stepCount === 1 ? "step" : "steps"} — {open ? "collapse" : "expand"}
      </button>
      {open ? children : null}
    </div>
  );
}
