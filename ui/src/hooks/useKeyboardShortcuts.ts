import { useCallback, useEffect, useRef, useState } from "react";
import { isEditableTarget, isDialogOpen, SEQUENCE_TIMEOUT_MS } from "../lib/keyboard-shortcuts";

/** Map of navigation sequences to route paths */
const NAV_SEQUENCES: Record<string, string> = {
  d: "/dashboard",
  n: "/inbox",
  i: "/issues",
  p: "/projects",
  o: "/goals",
  a: "/agents",
  c: "/costs",
  v: "/activity",
  s: "/company/settings",
  r: "/org",
};

interface ShortcutHandlers {
  onNavigate: (path: string) => void;
  onNewIssue: () => void;
  onNewProject: () => void;
  onNewAgent: () => void;
  onToggleSidebar: () => void;
  onTogglePanel: () => void;
  onShowShortcuts: () => void;
}

/**
 * Central keyboard shortcuts handler.
 * Handles single-key shortcuts, G-key navigation sequences,
 * and the ? help shortcut. Cmd+K is handled by CommandPalette directly.
 *
 * Returns the pending sequence key (e.g. "g") for the SequenceIndicator.
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers): {
  pendingKey: string | null;
} {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const clearPending = useCallback(() => {
    pendingRef.current = null;
    setPendingKey(null);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Never intercept when typing in inputs or when a dialog is open
      if (isEditableTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key;
      const h = handlersRef.current;

      // If we're in a pending G-sequence, resolve it
      if (pendingRef.current === "g") {
        clearPending();
        const route = NAV_SEQUENCES[key];
        if (route) {
          e.preventDefault();
          h.onNavigate(route);
        }
        return;
      }

      // Don't fire shortcuts when a dialog/overlay is open (except Escape)
      if (key !== "Escape" && isDialogOpen()) return;

      switch (key) {
        case "g":
          e.preventDefault();
          pendingRef.current = "g";
          setPendingKey("g");
          timeoutRef.current = setTimeout(clearPending, SEQUENCE_TIMEOUT_MS);
          break;
        case "c":
          e.preventDefault();
          h.onNewIssue();
          break;
        case "p":
          e.preventDefault();
          h.onNewProject();
          break;
        case "a":
          e.preventDefault();
          h.onNewAgent();
          break;
        case "[":
          e.preventDefault();
          h.onToggleSidebar();
          break;
        case "]":
          e.preventDefault();
          h.onTogglePanel();
          break;
        case "?":
          e.preventDefault();
          h.onShowShortcuts();
          break;
        default:
          break;
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [clearPending]);

  return { pendingKey };
}
