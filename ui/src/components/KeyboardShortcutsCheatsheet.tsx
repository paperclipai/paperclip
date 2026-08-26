import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";

interface ShortcutEntry {
  keys: string[];
  label: string;
  /** Render keys as a simultaneous chord (joined with "+") rather than a
   *  "then" sequence. */
  combo?: boolean;
}

// Platform-appropriate label for the Cmd/Ctrl modifier so the cheatsheet shows
// the same key the user actually presses (re-pointed in the collapsible sidebar
// work — Cmd/Ctrl+B toggles the rail).
function getPlatformLabel() {
  if (typeof navigator === "undefined") return "";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return nav.userAgentData?.platform || navigator.userAgent || "";
}

const META_KEY = /Mac|iPhone|iPad|iPod/.test(getPlatformLabel()) ? "⌘" : t("app.keyboardShortcutsCheatsheet.ctrl", { defaultValue: "Ctrl" });

interface ShortcutSection {
  title: string;
  shortcuts: ShortcutEntry[];
}

const sections: ShortcutSection[] = [
  {
    title: "Inbox",
    shortcuts: [
      { keys: ["j"], label: t("app.keyboardShortcutsCheatsheet.moveDown", { defaultValue: "Move down" }) },
      { keys: ["↓"], label: t("app.keyboardShortcutsCheatsheet.moveDown", { defaultValue: "Move down" }) },
      { keys: ["k"], label: t("app.keyboardShortcutsCheatsheet.moveUp", { defaultValue: "Move up" }) },
      { keys: ["↑"], label: t("app.keyboardShortcutsCheatsheet.moveUp", { defaultValue: "Move up" }) },
      { keys: ["←"], label: t("app.keyboardShortcutsCheatsheet.collapseSelectedGroup", { defaultValue: "Collapse selected group" }) },
      { keys: ["→"], label: t("app.keyboardShortcutsCheatsheet.expandSelectedGroup", { defaultValue: "Expand selected group" }) },
      { keys: ["Enter"], label: t("app.keyboardShortcutsCheatsheet.openSelectedItem", { defaultValue: "Open selected item" }) },
      { keys: ["a"], label: t("app.keyboardShortcutsCheatsheet.archiveItem", { defaultValue: "Archive item" }) },
      { keys: ["y"], label: t("app.keyboardShortcutsCheatsheet.archiveItem", { defaultValue: "Archive item" }) },
      { keys: ["r"], label: t("app.keyboardShortcutsCheatsheet.markAsRead", { defaultValue: "Mark as read" }) },
      { keys: ["U"], label: t("app.keyboardShortcutsCheatsheet.markAsUnread", { defaultValue: "Mark as unread" }) },
    ],
  },
  {
    title: "Task detail",
    shortcuts: [
      { keys: ["y"], label: t("app.keyboardShortcutsCheatsheet.quickArchiveBackToInbox", { defaultValue: "Quick-archive back to inbox" }) },
      { keys: ["g", "i"], label: t("app.keyboardShortcutsCheatsheet.goToInbox", { defaultValue: "Go to inbox" }) },
      { keys: ["g", "c"], label: t("app.keyboardShortcutsCheatsheet.focusCommentComposer", { defaultValue: "Focus comment composer" }) },
    ],
  },
  {
    title: "Decisions",
    shortcuts: [
      { keys: ["j"], label: t("app.keyboardShortcutsCheatsheet.moveDown", { defaultValue: "Move down" }) },
      { keys: ["↓"], label: t("app.keyboardShortcutsCheatsheet.moveDown", { defaultValue: "Move down" }) },
      { keys: ["k"], label: t("app.keyboardShortcutsCheatsheet.moveUp", { defaultValue: "Move up" }) },
      { keys: ["↑"], label: t("app.keyboardShortcutsCheatsheet.moveUp", { defaultValue: "Move up" }) },
      { keys: ["Enter"], label: t("app.keyboardShortcutsCheatsheet.openOrCloseSelectedDecision", { defaultValue: "Open or close selected decision" }) },
      { keys: ["x"], label: t("app.keyboardShortcutsCheatsheet.dismissSelectedDecision", { defaultValue: "Dismiss selected decision" }) },
    ],
  },
  {
    title: "Global",
    shortcuts: [
      { keys: ["/"], label: t("app.keyboardShortcutsCheatsheet.searchCurrentPageOrQuickSearch", { defaultValue: "Search current page or quick search" }) },
      { keys: ["c"], label: t("app.keyboardShortcutsCheatsheet.newTask", { defaultValue: "New task" }) },
      { keys: ["["], label: t("app.keyboardShortcutsCheatsheet.toggleSidebar", { defaultValue: "Toggle sidebar" }) },
      { keys: [META_KEY, "B"], label: t("app.keyboardShortcutsCheatsheet.collapseOrExpandSidebar", { defaultValue: "Collapse or expand sidebar" }), combo: true },
      { keys: ["]"], label: t("app.keyboardShortcutsCheatsheet.togglePanel", { defaultValue: "Toggle panel" }) },
      { keys: ["?"], label: t("app.keyboardShortcutsCheatsheet.showKeyboardShortcuts", { defaultValue: "Show keyboard shortcuts" }) },
    ],
  },
];

function KeyCap({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-xs font-medium text-foreground shadow-(--shadow-extract-10)">
      {children}
    </kbd>
  );
}

export function KeyboardShortcutsCheatsheetContent() {
  return (
    <>
      <div className="divide-y divide-border border-t border-border">
        {sections.map((section) => (
          <div key={section.title} className="px-5 py-3">
            <h3 className="mb-2 text-(length:--text-micro) font-semibold uppercase tracking-wider text-muted-foreground">
              {section.title}
            </h3>
            <div className="space-y-1.5">
              {section.shortcuts.map((shortcut) => (
                <div
                  key={shortcut.label + shortcut.keys.join()}
                  className="flex items-center justify-between gap-4"
                >
                  <span className="text-sm text-foreground/90">{shortcut.label}</span>
                  <div className="flex items-center gap-1">
                    {shortcut.keys.map((key, i) => (
                      <span key={key} className="flex items-center gap-1">
                        {i > 0 && (
                          <span className="text-xs text-muted-foreground">
                            {shortcut.combo ? "+" : "then"}
                          </span>
                        )}
                        <KeyCap>{key}</KeyCap>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-border px-5 py-3">
        <p className="text-xs text-muted-foreground"> { t("app.keyboardShortcutsCheatsheet.press", { defaultValue: "Press" }) } <KeyCap>{ t("app.keyboardShortcutsCheatsheet.esc", { defaultValue: "Esc" }) }</KeyCap> to close &middot; Shortcuts are disabled in text fields
        </p>
      </div>
    </>
  );
}

export function KeyboardShortcutsCheatsheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md gap-0 p-0 overflow-hidden" showCloseButton={false}>
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="text-base">{ t("app.keyboardShortcutsCheatsheet.keyboardShortcuts", { defaultValue: "Keyboard shortcuts" }) }</DialogTitle>
        </DialogHeader>
        <KeyboardShortcutsCheatsheetContent />
      </DialogContent>
    </Dialog>
  );
}
