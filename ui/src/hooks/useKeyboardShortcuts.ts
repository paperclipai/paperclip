import { useEffect } from "react";
import {
  focusPageSearchShortcutTarget,
  hasBlockingShortcutDialog,
  isKeyboardShortcutTextInputTarget,
} from "../lib/keyboardShortcuts";

interface ShortcutHandlers {
  enabled?: boolean;
  onNewIssue?: () => void;
  onSearch?: () => void;
  onToggleSidebar?: () => void;
  onToggleCollapse?: () => void;
  onTogglePanel?: () => void;
  onShowShortcuts?: () => void;
}

export function useKeyboardShortcuts({
  enabled = true,
  onNewIssue,
  onSearch,
  onToggleSidebar,
  onToggleCollapse,
  onTogglePanel,
  onShowShortcuts,
}: ShortcutHandlers) {
  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) {
        return;
      }

      // Don't fire shortcuts when typing in inputs
      if (isKeyboardShortcutTextInputTarget(e.target)) {
        return;
      }

      // / → Page search when available, otherwise quick search
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (hasBlockingShortcutDialog()) {
          return;
        }

        e.preventDefault();
        if (!focusPageSearchShortcutTarget()) {
          onSearch?.();
        }
        return;
      }

      // ? → Show keyboard shortcuts cheatsheet
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onShowShortcuts?.();
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

      // Cmd/Ctrl+B → Collapse/expand sidebar (desktop) or toggle drawer (mobile)
      if ((e.key === "b" || e.key === "B") && (e.metaKey || e.ctrlKey) && !e.altKey) {
        e.preventDefault();
        onToggleCollapse?.();
      }

      // ] → Toggle Panel
      if (e.key === "]" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onTogglePanel?.();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [enabled, onNewIssue, onSearch, onToggleSidebar, onToggleCollapse, onTogglePanel, onShowShortcuts]);
}
