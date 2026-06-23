import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t, useTranslation } from "@/i18n";

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

const META_KEY = /Mac|iPhone|iPad|iPod/.test(getPlatformLabel()) ? "⌘" : "Ctrl";

interface ShortcutSection {
  title: string;
  shortcuts: ShortcutEntry[];
}

function getSections(): ShortcutSection[] {
  return [
    {
      title: t("components.keyboardShortcutsCheatsheet.sectionInbox", { defaultValue: "Inbox" }),
      shortcuts: [
        { keys: ["j"], label: t("components.keyboardShortcutsCheatsheet.moveDown", { defaultValue: "Move down" }) },
        { keys: ["↓"], label: t("components.keyboardShortcutsCheatsheet.moveDown", { defaultValue: "Move down" }) },
        { keys: ["k"], label: t("components.keyboardShortcutsCheatsheet.moveUp", { defaultValue: "Move up" }) },
        { keys: ["↑"], label: t("components.keyboardShortcutsCheatsheet.moveUp", { defaultValue: "Move up" }) },
        { keys: ["←"], label: t("components.keyboardShortcutsCheatsheet.collapseSelectedGroup", { defaultValue: "Collapse selected group" }) },
        { keys: ["→"], label: t("components.keyboardShortcutsCheatsheet.expandSelectedGroup", { defaultValue: "Expand selected group" }) },
        { keys: ["Enter"], label: t("components.keyboardShortcutsCheatsheet.openSelectedItem", { defaultValue: "Open selected item" }) },
        { keys: ["a"], label: t("components.keyboardShortcutsCheatsheet.archiveItem", { defaultValue: "Archive item" }) },
        { keys: ["y"], label: t("components.keyboardShortcutsCheatsheet.archiveItem", { defaultValue: "Archive item" }) },
        { keys: ["r"], label: t("components.keyboardShortcutsCheatsheet.markAsRead", { defaultValue: "Mark as read" }) },
        { keys: ["U"], label: t("components.keyboardShortcutsCheatsheet.markAsUnread", { defaultValue: "Mark as unread" }) },
      ],
    },
    {
      title: t("components.keyboardShortcutsCheatsheet.sectionTaskDetail", { defaultValue: "Task detail" }),
      shortcuts: [
        { keys: ["y"], label: t("components.keyboardShortcutsCheatsheet.quickArchiveBackToInbox", { defaultValue: "Quick-archive back to inbox" }) },
        { keys: ["g", "i"], label: t("components.keyboardShortcutsCheatsheet.goToInbox", { defaultValue: "Go to inbox" }) },
        { keys: ["g", "c"], label: t("components.keyboardShortcutsCheatsheet.focusCommentComposer", { defaultValue: "Focus comment composer" }) },
      ],
    },
    {
      title: t("components.keyboardShortcutsCheatsheet.sectionGlobal", { defaultValue: "Global" }),
      shortcuts: [
        { keys: ["/"], label: t("components.keyboardShortcutsCheatsheet.searchCurrentPageOrQuickSearch", { defaultValue: "Search current page or quick search" }) },
        { keys: ["c"], label: t("components.keyboardShortcutsCheatsheet.newTask", { defaultValue: "New task" }) },
        { keys: ["["], label: t("components.keyboardShortcutsCheatsheet.toggleSidebar", { defaultValue: "Toggle sidebar" }) },
        { keys: [META_KEY, "B"], label: t("components.keyboardShortcutsCheatsheet.collapseOrExpandSidebar", { defaultValue: "Collapse or expand sidebar" }), combo: true },
        { keys: ["]"], label: t("components.keyboardShortcutsCheatsheet.togglePanel", { defaultValue: "Toggle panel" }) },
        { keys: ["?"], label: t("components.keyboardShortcutsCheatsheet.showKeyboardShortcuts", { defaultValue: "Show keyboard shortcuts" }) },
      ],
    },
  ];
}

function KeyCap({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-xs font-medium text-foreground shadow-[0_1px_0_1px_hsl(var(--border))]">
      {children}
    </kbd>
  );
}

export function KeyboardShortcutsCheatsheetContent() {
  const { t } = useTranslation();
  return (
    <>
      <div className="divide-y divide-border border-t border-border">
        {getSections().map((section) => (
          <div key={section.title} className="px-5 py-3">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
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
                            {shortcut.combo
                              ? "+"
                              : t("components.keyboardShortcutsCheatsheet.thenConnector", {
                                  defaultValue: "then",
                                })}
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
        <p className="text-xs text-muted-foreground">
          {t("components.keyboardShortcutsCheatsheet.footerPress", { defaultValue: "Press" })}{" "}
          <KeyCap>Esc</KeyCap>{" "}
          {t("components.keyboardShortcutsCheatsheet.footerToClose", {
            defaultValue: "to close · Shortcuts are disabled in text fields",
          })}
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
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md gap-0 p-0 overflow-hidden" showCloseButton={false}>
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="text-base">
            {t("components.keyboardShortcutsCheatsheet.dialogTitle", {
              defaultValue: "Keyboard shortcuts",
            })}
          </DialogTitle>
        </DialogHeader>
        <KeyboardShortcutsCheatsheetContent />
      </DialogContent>
    </Dialog>
  );
}
