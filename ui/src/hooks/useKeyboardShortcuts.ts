import { useEffect } from "react";
import {
  focusPageSearchShortcutTarget,
  hasBlockingShortcutDialog,
  isKeyboardShortcutTextInputTarget,
  resolveIssueDetailGoKeyAction,
} from "../lib/keyboardShortcuts";

interface ShortcutHandlers {
  enabled?: boolean;
  onNewIssue?: () => void;
  onSearch?: () => void;
  onToggleSidebar?: () => void;
  onToggleCollapse?: () => void;
  onTogglePanel?: () => void;
  onShowShortcuts?: () => void;
  onGoToInbox?: () => void;
}

export function useKeyboardShortcuts({
  enabled = true,
  onNewIssue,
  onSearch,
  onToggleSidebar,
  onToggleCollapse,
  onTogglePanel,
  onShowShortcuts,
  onGoToInbox,
}: ShortcutHandlers) {
  useEffect(() => {
    if (!enabled) return;

    // g → i chord state. IssueDetail runs its own capture-phase handler with
    // extra chords (g c, g f) and stops propagation when it handles one, so
    // this bubble-phase chord only fires outside the issue detail page.
    let goChordArmed = false;
    let goChordTimeout: number | null = null;
    const clearGoChordTimeout = () => {
      if (goChordTimeout !== null) {
        window.clearTimeout(goChordTimeout);
        goChordTimeout = null;
      }
    };
    const disarmGoChord = () => {
      goChordArmed = false;
      clearGoChordTimeout();
    };
    const armGoChord = () => {
      goChordArmed = true;
      clearGoChordTimeout();
      goChordTimeout = window.setTimeout(() => {
        goChordArmed = false;
        goChordTimeout = null;
      }, 1200);
    };

    function handleKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) {
        disarmGoChord();
        return;
      }

      if (onGoToInbox) {
        const chordAction = resolveIssueDetailGoKeyAction({
          armed: goChordArmed,
          defaultPrevented: e.defaultPrevented,
          key: e.key,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          target: e.target,
          hasOpenDialog: hasBlockingShortcutDialog(),
        });
        if (chordAction === "arm") {
          armGoChord();
          return;
        }
        if (chordAction === "navigate_inbox") {
          disarmGoChord();
          e.preventDefault();
          onGoToInbox();
          return;
        }
        if (chordAction === "focus_comment" || chordAction === "open_file_viewer") {
          // Armed chord keys that only mean something on the issue detail
          // page — swallow them so they don't trigger bare shortcuts (c).
          disarmGoChord();
          e.preventDefault();
          return;
        }
        if (chordAction === "disarm") disarmGoChord();
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

    const handlePointerDown = () => disarmGoChord();
    const handleFocusIn = (e: FocusEvent) => {
      if (e.target instanceof HTMLElement && e.target !== document.body) disarmGoChord();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      disarmGoChord();
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [enabled, onNewIssue, onSearch, onToggleSidebar, onToggleCollapse, onTogglePanel, onShowShortcuts, onGoToInbox]);
}
