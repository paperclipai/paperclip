import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTranslation } from "@/i18n";

interface ShortcutEntry {
  keys: string[];
  labelKey: string;
}

interface ShortcutSection {
  titleKey: string;
  shortcuts: ShortcutEntry[];
}

const sections: ShortcutSection[] = [
  {
    titleKey: "pages.keyboardShortcuts.inbox",
    shortcuts: [
      { keys: ["j"], labelKey: "pages.keyboardShortcuts.moveDown" },
      { keys: ["↓"], labelKey: "pages.keyboardShortcuts.moveDown" },
      { keys: ["k"], labelKey: "pages.keyboardShortcuts.moveUp" },
      { keys: ["↑"], labelKey: "pages.keyboardShortcuts.moveUp" },
      { keys: ["←"], labelKey: "pages.keyboardShortcuts.collapseSelected" },
      { keys: ["→"], labelKey: "pages.keyboardShortcuts.expandSelected" },
      { keys: ["Enter"], labelKey: "pages.keyboardShortcuts.openSelected" },
      { keys: ["a"], labelKey: "pages.keyboardShortcuts.archiveItem" },
      { keys: ["y"], labelKey: "pages.keyboardShortcuts.archiveItem" },
      { keys: ["r"], labelKey: "pages.keyboardShortcuts.markAsRead" },
      { keys: ["U"], labelKey: "pages.keyboardShortcuts.markAsUnread" },
    ],
  },
  {
    titleKey: "pages.keyboardShortcuts.issueDetail",
    shortcuts: [
      { keys: ["y"], labelKey: "pages.keyboardShortcuts.quickArchive" },
      { keys: ["g", "i"], labelKey: "pages.keyboardShortcuts.goToInbox" },
      { keys: ["g", "c"], labelKey: "pages.keyboardShortcuts.focusCommentComposer" },
    ],
  },
  {
    titleKey: "pages.keyboardShortcuts.global",
    shortcuts: [
      { keys: ["/"], labelKey: "pages.keyboardShortcuts.searchPage" },
      { keys: ["c"], labelKey: "pages.keyboardShortcuts.newIssue" },
      { keys: ["["], labelKey: "pages.keyboardShortcuts.toggleSidebar" },
      { keys: ["]"], labelKey: "pages.keyboardShortcuts.togglePanel" },
      { keys: ["?"], labelKey: "pages.keyboardShortcuts.showShortcuts" },
    ],
  },
];

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
        {sections.map((section) => (
          <div key={section.titleKey} className="px-5 py-3">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t(section.titleKey)}
            </h3>
            <div className="space-y-1.5">
              {section.shortcuts.map((shortcut) => (
                <div
                  key={shortcut.labelKey + shortcut.keys.join()}
                  className="flex items-center justify-between gap-4"
                >
                  <span className="text-sm text-foreground/90">{t(shortcut.labelKey)}</span>
                  <div className="flex items-center gap-1">
                    {shortcut.keys.map((key, i) => (
                      <span key={key} className="flex items-center gap-1">
                        {i > 0 && <span className="text-xs text-muted-foreground">{t("pages.keyboardShortcuts.then")}</span>}
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
          {t("pages.keyboardShortcuts.pressEscToClose")}
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
          <DialogTitle className="text-base">{t("pages.keyboardShortcuts.title")}</DialogTitle>
        </DialogHeader>
        <KeyboardShortcutsCheatsheetContent />
      </DialogContent>
    </Dialog>
  );
}
