import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTranslation } from "@/i18n";

interface ShortcutEntry {
  keys: string[];
  label: string;
}

interface ShortcutSection {
  title: string;
  shortcuts: ShortcutEntry[];
}

function useShortcutSections(): ShortcutSection[] {
  const { t } = useTranslation();
  return [
    {
      title: t("shortcuts.inbox.title", { defaultValue: "Inbox" }),
      shortcuts: [
        { keys: ["j"], label: t("shortcuts.moveDown", { defaultValue: "Move down" }) },
        { keys: ["↓"], label: t("shortcuts.moveDown", { defaultValue: "Move down" }) },
        { keys: ["k"], label: t("shortcuts.moveUp", { defaultValue: "Move up" }) },
        { keys: ["↑"], label: t("shortcuts.moveUp", { defaultValue: "Move up" }) },
        { keys: ["←"], label: t("shortcuts.collapseGroup", { defaultValue: "Collapse selected group" }) },
        { keys: ["→"], label: t("shortcuts.expandGroup", { defaultValue: "Expand selected group" }) },
        { keys: ["Enter"], label: t("shortcuts.openItem", { defaultValue: "Open selected item" }) },
        { keys: ["a"], label: t("shortcuts.archiveItem", { defaultValue: "Archive item" }) },
        { keys: ["y"], label: t("shortcuts.archiveItem", { defaultValue: "Archive item" }) },
        { keys: ["r"], label: t("shortcuts.markRead", { defaultValue: "Mark as read" }) },
        { keys: ["U"], label: t("shortcuts.markUnread", { defaultValue: "Mark as unread" }) },
      ],
    },
    {
      title: t("shortcuts.issueDetail.title", { defaultValue: "Issue detail" }),
      shortcuts: [
        { keys: ["y"], label: t("shortcuts.quickArchive", { defaultValue: "Quick-archive back to inbox" }) },
        { keys: ["g", "i"], label: t("shortcuts.goToInbox", { defaultValue: "Go to inbox" }) },
        { keys: ["g", "c"], label: t("shortcuts.focusComposer", { defaultValue: "Focus comment composer" }) },
      ],
    },
    {
      title: t("shortcuts.global.title", { defaultValue: "Global" }),
      shortcuts: [
        { keys: ["/"], label: t("shortcuts.search", { defaultValue: "Search current page or quick search" }) },
        { keys: ["c"], label: t("shortcuts.newIssue", { defaultValue: "New issue" }) },
        { keys: ["["], label: t("shortcuts.toggleSidebar", { defaultValue: "Toggle sidebar" }) },
        { keys: ["]"], label: t("shortcuts.togglePanel", { defaultValue: "Toggle panel" }) },
        { keys: ["?"], label: t("shortcuts.showShortcuts", { defaultValue: "Show keyboard shortcuts" }) },
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
  const sections = useShortcutSections();
  return (
    <>
      <div className="divide-y divide-border border-t border-border">
        {sections.map((section) => (
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
                        {i > 0 && <span className="text-xs text-muted-foreground">{t("shortcuts.then", { defaultValue: "then" })}</span>}
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
          {t("shortcuts.pressEsc", { defaultValue: "Press" })} <KeyCap>Esc</KeyCap> {t("shortcuts.toClose", { defaultValue: "to close · Shortcuts are disabled in text fields" })}
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
          <DialogTitle className="text-base">{t("shortcuts.title", { defaultValue: "Keyboard shortcuts" })}</DialogTitle>
        </DialogHeader>
        <KeyboardShortcutsCheatsheetContent />
      </DialogContent>
    </Dialog>
  );
}
