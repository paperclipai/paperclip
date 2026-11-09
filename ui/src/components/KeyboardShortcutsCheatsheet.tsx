import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t, useTranslation } from "@/i18n";

interface ShortcutEntry {
  keys: string[];
  label: string;
  /** Render keys as a simultaneous chord (joined with "+") rather than a
   *  "then" sequence. */
  combo?: boolean;
}

interface ShortcutSection {
  title: string;
  shortcuts: ShortcutEntry[];
}

function getSections(): ShortcutSection[] {
  return [
    {
      title: t("common.keyboardShortcutsCheatsheet.sectionInbox"),
      shortcuts: [
        { keys: ["j"], label: t("common.keyboardShortcutsCheatsheet.moveDown") },
        { keys: ["↓"], label: t("common.keyboardShortcutsCheatsheet.moveDown") },
        { keys: ["k"], label: t("common.keyboardShortcutsCheatsheet.moveUp") },
        { keys: ["↑"], label: t("common.keyboardShortcutsCheatsheet.moveUp") },
        { keys: ["←"], label: t("common.keyboardShortcutsCheatsheet.collapseGroup") },
        { keys: ["→"], label: t("common.keyboardShortcutsCheatsheet.expandGroup") },
        { keys: ["Enter"], label: t("common.keyboardShortcutsCheatsheet.openItem") },
        { keys: ["a"], label: t("common.keyboardShortcutsCheatsheet.archiveItem") },
        { keys: ["y"], label: t("common.keyboardShortcutsCheatsheet.archiveItem") },
        { keys: ["r"], label: t("common.keyboardShortcutsCheatsheet.markRead") },
        { keys: ["U"], label: t("common.keyboardShortcutsCheatsheet.markUnread") },
      ],
    },
    {
      title: t("common.keyboardShortcutsCheatsheet.sectionTaskDetail"),
      shortcuts: [
        { keys: ["y"], label: t("common.keyboardShortcutsCheatsheet.quickArchive") },
        { keys: ["g", "i"], label: t("common.keyboardShortcutsCheatsheet.goToInbox") },
        { keys: ["g", "c"], label: t("common.keyboardShortcutsCheatsheet.focusComment") },
      ],
    },
    {
      title: t("common.keyboardShortcutsCheatsheet.sectionDecisions"),
      shortcuts: [
        { keys: ["j"], label: t("common.keyboardShortcutsCheatsheet.moveDown") },
        { keys: ["↓"], label: t("common.keyboardShortcutsCheatsheet.moveDown") },
        { keys: ["k"], label: t("common.keyboardShortcutsCheatsheet.moveUp") },
        { keys: ["↑"], label: t("common.keyboardShortcutsCheatsheet.moveUp") },
        { keys: ["Enter"], label: t("common.keyboardShortcutsCheatsheet.openOrCloseDecision") },
        { keys: ["x"], label: t("common.keyboardShortcutsCheatsheet.dismissDecision") },
      ],
    },
    {
      title: t("common.keyboardShortcutsCheatsheet.sectionGlobal"),
      shortcuts: [
        { keys: ["/"], label: t("common.keyboardShortcutsCheatsheet.searchPage") },
        { keys: ["c"], label: t("common.keyboardShortcutsCheatsheet.newTask") },
        { keys: ["["], label: t("common.keyboardShortcutsCheatsheet.toggleSidebar") },
        { keys: ["]"], label: t("common.keyboardShortcutsCheatsheet.togglePanel") },
        { keys: ["?"], label: t("common.keyboardShortcutsCheatsheet.showShortcuts") },
      ],
    },
  ];
}

function KeyCap({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-xs font-medium text-foreground shadow-(--shadow-extract-10)">
      {children}
    </kbd>
  );
}

export function KeyboardShortcutsCheatsheetContent() {
  const { t } = useTranslation();
  const sections = getSections();
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
                            {shortcut.combo ? "+" : t("common.keyboardShortcutsCheatsheet.then")}
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
          {t("common.keyboardShortcutsCheatsheet.pressBefore")} <KeyCap>Esc</KeyCap> {t("common.keyboardShortcutsCheatsheet.closeAfter")} &middot; {t("common.keyboardShortcutsCheatsheet.disabledInFields")}
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
          <DialogTitle className="text-base">{t("common.keyboardShortcutsCheatsheet.title")}</DialogTitle>
        </DialogHeader>
        <KeyboardShortcutsCheatsheetContent />
      </DialogContent>
    </Dialog>
  );
}
