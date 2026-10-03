import { createContext, useContext, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import type { TaskChatItem } from "./task-chat-model";

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
 * Rows that Focus view never folds: resolved request receipts record an
 * operator decision, and plan documents are durable artifacts rather than
 * runner noise. Pending requests render at the composer, not in the timeline.
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

/**
 * Focus view only folds Paperclip Runner (standalone-header) turns. Threads
 * without such a turn keep the classic fold, so the toggle would do nothing.
 */
export function taskChatThreadHasFocusTurns(items: readonly TaskChatItem[]): boolean {
  return items.some(
    (item) =>
      (item.kind === "turn" && item.standaloneHeader === true) ||
      (item.kind === "message" && item.attachedTurn?.standaloneHeader === true),
  );
}

const VIEW_MODE_OPTIONS: { mode: TaskChatViewMode; labelKey: string }[] = [
  { mode: "full", labelKey: "taskChat.focus.fullView" },
  { mode: "focus", labelKey: "taskChat.focus.focusView" },
];

export function TaskChatViewModeToggle({
  mode,
  onChange,
}: {
  mode: TaskChatViewMode;
  onChange: (mode: TaskChatViewMode) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="group"
      aria-label={t("taskChat.focus.viewGroup")}
      className="flex items-center justify-end gap-1 text-xs text-muted-foreground"
      data-testid="task-chat-view-mode-toggle"
    >
      {VIEW_MODE_OPTIONS.map((option) => (
        <Button
          key={option.mode}
          type="button"
          variant="outline"
          size="xs"
          aria-pressed={mode === option.mode}
          data-view-mode={option.mode}
          className={cn(
            "bg-card",
            mode === option.mode
              ? "bg-accent text-accent-foreground dark:bg-accent"
              : "text-muted-foreground",
          )}
          onClick={() => onChange(option.mode)}
        >
          {t(option.labelKey)}
        </Button>
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
  const { t } = useTranslation();
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
        {open ? t("taskChat.focus.collapse") : t("taskChat.focus.expand")}
        <span className="sr-only">
          {" "}
          {t("taskChat.focus.stepCount", { count: stepCount })}
        </span>
      </button>
      {open ? children : null}
    </div>
  );
}
