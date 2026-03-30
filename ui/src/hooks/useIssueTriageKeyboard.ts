import { useEffect, useCallback } from "react";

export interface IssueTriageKeyboardOptions {
  /** Total number of visible issues in the flat list */
  issueCount: number;
  /** Currently selected index (-1 = none) */
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  /** Called when user presses Enter on a selected issue */
  onOpen: (index: number) => void;
  /** Called when user presses a status shortcut key on the selected issue */
  onSetStatus: (index: number, status: string) => void;
  /** Called when user presses 'a' to open assignee picker on the selected issue */
  onOpenAssignee: (index: number) => void;
  /** Whether the hook is active (e.g. only in list view) */
  enabled?: boolean;
}

const STATUS_KEYS: Record<string, string> = {
  "1": "todo",
  "2": "in_progress",
  "3": "in_review",
  "4": "done",
  "5": "cancelled",
};

export function useIssueTriageKeyboard({
  issueCount,
  selectedIndex,
  onSelectIndex,
  onOpen,
  onSetStatus,
  onOpenAssignee,
  enabled = true,
}: IssueTriageKeyboardOptions) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled || issueCount === 0) return;

      // Don't fire shortcuts when typing in inputs
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      // Don't interfere with modifier combos (Cmd/Ctrl shortcuts handled elsewhere)
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case "j":
        case "ArrowDown": {
          e.preventDefault();
          const next =
            selectedIndex < 0 ? 0 : Math.min(selectedIndex + 1, issueCount - 1);
          onSelectIndex(next);
          break;
        }
        case "k":
        case "ArrowUp": {
          e.preventDefault();
          const prev =
            selectedIndex < 0
              ? issueCount - 1
              : Math.max(selectedIndex - 1, 0);
          onSelectIndex(prev);
          break;
        }
        case "Enter": {
          if (selectedIndex >= 0) {
            e.preventDefault();
            onOpen(selectedIndex);
          }
          break;
        }
        case "Escape": {
          if (selectedIndex >= 0) {
            e.preventDefault();
            onSelectIndex(-1);
          }
          break;
        }
        case "a": {
          if (selectedIndex >= 0) {
            e.preventDefault();
            onOpenAssignee(selectedIndex);
          }
          break;
        }
        default: {
          // Status shortcuts: 1-5
          if (selectedIndex >= 0 && STATUS_KEYS[e.key]) {
            e.preventDefault();
            onSetStatus(selectedIndex, STATUS_KEYS[e.key]);
          }
          break;
        }
      }
    },
    [enabled, issueCount, selectedIndex, onSelectIndex, onOpen, onSetStatus, onOpenAssignee],
  );

  useEffect(() => {
    if (!enabled) return;
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [enabled, handleKeyDown]);
}
