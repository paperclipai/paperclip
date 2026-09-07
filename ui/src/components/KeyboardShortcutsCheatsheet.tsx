import { useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface ShortcutEntry {
  keys: string[];
  labelKey: string;
  /** Render keys as a simultaneous chord (joined with "+") rather than a
   *  "then" sequence. */
  combo?: boolean;
}

interface ShortcutSection {
  titleKey: string;
  shortcuts: ShortcutEntry[];
}

const sections: ShortcutSection[] = [
  {
    titleKey: "localizationKeyboard.inbox",
    shortcuts: [
      { keys: ["j"], labelKey: "localizationKeyboard.moveDown" },
      { keys: ["↓"], labelKey: "localizationKeyboard.moveDown" },
      { keys: ["k"], labelKey: "localizationKeyboard.moveUp" },
      { keys: ["↑"], labelKey: "localizationKeyboard.moveUp" },
      { keys: ["←"], labelKey: "localizationKeyboard.collapseGroup" },
      { keys: ["→"], labelKey: "localizationKeyboard.expandGroup" },
      { keys: ["Enter"], labelKey: "localizationKeyboard.openItem" },
      { keys: ["a"], labelKey: "localizationKeyboard.archive" },
      { keys: ["y"], labelKey: "localizationKeyboard.archive" },
      { keys: ["r"], labelKey: "localizationKeyboard.markRead" },
      { keys: ["U"], labelKey: "localizationKeyboard.markUnread" },
    ],
  },
  {
    titleKey: "localizationKeyboard.taskDetail",
    shortcuts: [
      { keys: ["y"], labelKey: "localizationKeyboard.quickArchive" },
      { keys: ["g", "i"], labelKey: "localizationKeyboard.goToInbox" },
      { keys: ["g", "c"], labelKey: "localizationKeyboard.focusComment" },
    ],
  },
  {
    titleKey: "localizationKeyboard.decisions",
    shortcuts: [
      { keys: ["j"], labelKey: "localizationKeyboard.moveDown" },
      { keys: ["↓"], labelKey: "localizationKeyboard.moveDown" },
      { keys: ["k"], labelKey: "localizationKeyboard.moveUp" },
      { keys: ["↑"], labelKey: "localizationKeyboard.moveUp" },
      { keys: ["Enter"], labelKey: "localizationKeyboard.toggleDecision" },
      { keys: ["x"], labelKey: "localizationKeyboard.dismissDecision" },
    ],
  },
  {
    titleKey: "localizationKeyboard.global",
    shortcuts: [
      { keys: ["/"], labelKey: "localizationKeyboard.search" },
      { keys: ["c"], labelKey: "localizationKeyboard.newTask" },
      { keys: ["["], labelKey: "localizationKeyboard.toggleSidebar" },
      { keys: ["]"], labelKey: "localizationKeyboard.togglePanel" },
      { keys: ["?"], labelKey: "localizationKeyboard.showShortcuts" },
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
  const { t } = useTranslation();
  return (
    <>
      <div className="divide-y divide-border border-t border-border">
        {sections.map((section) => (
          <div key={section.titleKey} className="px-5 py-3">
            <h3 className="mb-2 text-(length:--text-micro) font-semibold uppercase tracking-wider text-muted-foreground">
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
                        {i > 0 && (
                          <span className="text-xs text-muted-foreground">
                            {shortcut.combo ? "+" : t("localizationKeyboard.then")}
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
          <Trans i18nKey="localizationKeyboard.help" components={{ key: <KeyCap>Esc</KeyCap> }} />
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
          <DialogTitle className="text-base">{t("localizationKeyboard.title")}</DialogTitle>
        </DialogHeader>
        <KeyboardShortcutsCheatsheetContent />
      </DialogContent>
    </Dialog>
  );
}
