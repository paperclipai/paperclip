import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTranslation } from "react-i18next";

interface ShortcutEntry {
  keys: string[];
  label: string;
}

interface ShortcutSection {
  title: string;
  shortcuts: ShortcutEntry[];
}

function getSections(t: (key: string) => string): ShortcutSection[] {
  return [
    {
      title: t("keyboardShortcuts.sections.inbox"),
      shortcuts: [
        { keys: ["j"], label: t("keyboardShortcuts.labels.moveDown") },
        { keys: ["↓"], label: t("keyboardShortcuts.labels.moveDown") },
        { keys: ["k"], label: t("keyboardShortcuts.labels.moveUp") },
        { keys: ["↑"], label: t("keyboardShortcuts.labels.moveUp") },
        { keys: ["←"], label: t("keyboardShortcuts.labels.collapseSelectedGroup") },
        { keys: ["→"], label: t("keyboardShortcuts.labels.expandSelectedGroup") },
        { keys: ["Enter"], label: t("keyboardShortcuts.labels.openSelectedItem") },
        { keys: ["a"], label: t("keyboardShortcuts.labels.archiveItem") },
        { keys: ["y"], label: t("keyboardShortcuts.labels.archiveItem") },
        { keys: ["r"], label: t("keyboardShortcuts.labels.markAsRead") },
        { keys: ["U"], label: t("keyboardShortcuts.labels.markAsUnread") },
      ],
    },
    {
      title: t("keyboardShortcuts.sections.issueDetail"),
      shortcuts: [
        { keys: ["y"], label: t("keyboardShortcuts.labels.quickArchiveBackToInbox") },
        { keys: ["g", "i"], label: t("keyboardShortcuts.labels.goToInbox") },
        { keys: ["g", "c"], label: t("keyboardShortcuts.labels.focusCommentComposer") },
      ],
    },
    {
      title: t("keyboardShortcuts.sections.global"),
      shortcuts: [
        { keys: ["/"], label: t("keyboardShortcuts.labels.searchCurrentPage") },
        { keys: ["c"], label: t("keyboardShortcuts.labels.newIssue") },
        { keys: ["["], label: t("keyboardShortcuts.labels.toggleSidebar") },
        { keys: ["]"], label: t("keyboardShortcuts.labels.togglePanel") },
        { keys: ["?"], label: t("keyboardShortcuts.labels.showKeyboardShortcuts") },
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

export function KeyboardShortcutsCheatsheetContent({ t }: { t?: (key: string) => string }) {
  const tFn = t ?? ((k: string) => k);
  const sections = getSections(tFn);
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
                        {i > 0 && <span className="text-xs text-muted-foreground">{tFn("keyboardShortcuts.then")}</span>}
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
          {tFn("keyboardShortcuts.pressToClose")} <KeyCap>Esc</KeyCap> {tFn("keyboardShortcuts.toClose")} &middot; {tFn("keyboardShortcuts.disabledInTextFields")}
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
  const { t } = useTranslation("common");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md gap-0 p-0 overflow-hidden" showCloseButton={false}>
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="text-base">{t("keyboardShortcuts.title")}</DialogTitle>
        </DialogHeader>
        <KeyboardShortcutsCheatsheetContent t={t} />
      </DialogContent>
    </Dialog>
  );
}
