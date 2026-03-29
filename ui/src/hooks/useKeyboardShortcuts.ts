import { useEffect } from "react";

interface ShortcutHandlers {
  onNewIssue?: () => void;
  onToggleSidebar?: () => void;
  onTogglePanel?: () => void;
  onGlobalComposer?: () => void;
}

export function useKeyboardShortcuts({ onNewIssue, onToggleSidebar, onTogglePanel, onGlobalComposer }: ShortcutHandlers) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Cmd/Ctrl+J → Global Composer (works even in inputs)
      if (e.key === "j" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onGlobalComposer?.();
        return;
      }

      // Don't fire shortcuts when typing in inputs
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }

      // C → New Issue
      if (e.key === "c" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onNewIssue?.();
      }

      // [ → Toggle Sidebar
      if (e.key === "[" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onToggleSidebar?.();
      }

      // ] → Toggle Panel
      if (e.key === "]" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onTogglePanel?.();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onNewIssue, onToggleSidebar, onTogglePanel, onGlobalComposer]);
}
