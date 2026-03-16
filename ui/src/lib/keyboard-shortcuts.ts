/**
 * Centralized keyboard shortcuts registry.
 * Single source of truth for all shortcuts in the app.
 *
 * Key format:
 *   - Single keys: "c", "[", "]", "?"
 *   - Sequences: "g,d" (press G then D)
 *   - Modifier combos: "mod+k" (Cmd on Mac, Ctrl elsewhere)
 */

export interface Shortcut {
  id: string;
  keys: string;
  label: string;
  category: "navigation" | "actions" | "list" | "ui";
}

export const SHORTCUT_REGISTRY: Shortcut[] = [
  // Navigation (G-key sequences)
  { id: "go-dashboard", keys: "g,d", label: "Go to Dashboard", category: "navigation" },
  { id: "go-inbox", keys: "g,n", label: "Go to Inbox", category: "navigation" },
  { id: "go-issues", keys: "g,i", label: "Go to Issues", category: "navigation" },
  { id: "go-projects", keys: "g,p", label: "Go to Projects", category: "navigation" },
  { id: "go-goals", keys: "g,o", label: "Go to Goals", category: "navigation" },
  { id: "go-agents", keys: "g,a", label: "Go to Agents", category: "navigation" },
  { id: "go-costs", keys: "g,c", label: "Go to Costs", category: "navigation" },
  { id: "go-activity", keys: "g,v", label: "Go to Activity", category: "navigation" },
  { id: "go-settings", keys: "g,s", label: "Go to Settings", category: "navigation" },
  { id: "go-org", keys: "g,r", label: "Go to Org chart", category: "navigation" },

  // Actions
  { id: "new-issue", keys: "c", label: "Create new issue", category: "actions" },
  { id: "new-project", keys: "p", label: "Create new project", category: "actions" },
  { id: "new-agent", keys: "a", label: "Create new agent", category: "actions" },

  // List navigation
  { id: "list-down", keys: "j", label: "Move down", category: "list" },
  { id: "list-up", keys: "k", label: "Move up", category: "list" },
  { id: "list-open", keys: "Enter", label: "Open selected", category: "list" },

  // UI
  { id: "command-palette", keys: "mod+k", label: "Command palette", category: "ui" },
  { id: "shortcuts-help", keys: "?", label: "Keyboard shortcuts", category: "ui" },
  { id: "toggle-sidebar", keys: "[", label: "Toggle sidebar", category: "ui" },
  { id: "toggle-panel", keys: "]", label: "Toggle panel", category: "ui" },
  { id: "close", keys: "Escape", label: "Close / deselect", category: "ui" },
];

export const SEQUENCE_TIMEOUT_MS = 500;

const CATEGORY_LABELS: Record<Shortcut["category"], string> = {
  navigation: "Navigation",
  actions: "Actions",
  list: "List",
  ui: "UI",
};

export function categoryLabel(cat: Shortcut["category"]): string {
  return CATEGORY_LABELS[cat];
}

export function groupedShortcuts(): Record<Shortcut["category"], Shortcut[]> {
  const groups: Record<Shortcut["category"], Shortcut[]> = {
    navigation: [],
    actions: [],
    list: [],
    ui: [],
  };
  for (const s of SHORTCUT_REGISTRY) {
    groups[s.category].push(s);
  }
  return groups;
}

/**
 * Format shortcut keys for display.
 * "g,d" → ["G", "D"]
 * "mod+k" → ["⌘", "K"] (Mac) or ["Ctrl", "K"]
 */
export function formatKeys(keys: string): string[] {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

  if (keys.includes("+")) {
    return keys.split("+").map((part) => {
      if (part === "mod") return isMac ? "⌘" : "Ctrl";
      return part.toUpperCase();
    });
  }

  if (keys.includes(",")) {
    return keys.split(",").map((k) => k.toUpperCase());
  }

  if (keys === "Escape") return ["Esc"];
  if (keys === "Enter") return ["↵"];

  return [keys === "?" ? "?" : keys.toUpperCase()];
}

/** Check if focus is inside an editable element */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  // cmdk combobox input
  if (target.getAttribute("role") === "combobox") return true;
  return false;
}

/** Check if a dialog or overlay is currently open */
export function isDialogOpen(): boolean {
  return document.querySelector(
    "[data-state='open'][role='dialog'], [data-state='open'][role='alertdialog'], [cmdk-dialog]",
  ) !== null;
}

/** Get the shortcut hint for a navigation route */
export function getHintForRoute(path: string): string | undefined {
  const routeMap: Record<string, string> = {
    "/dashboard": "g,d",
    "/inbox": "g,n",
    "/issues": "g,i",
    "/projects": "g,p",
    "/goals": "g,o",
    "/agents": "g,a",
    "/costs": "g,c",
    "/activity": "g,v",
    "/company/settings": "g,s",
    "/org": "g,r",
  };
  return routeMap[path];
}

/** Get the shortcut hint for an action */
export function getHintForAction(actionId: string): string | undefined {
  const s = SHORTCUT_REGISTRY.find((r) => r.id === actionId);
  return s?.keys;
}
