import { t, useTranslation, Trans } from "@/i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

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

const sections: ShortcutSection[] = [
  {
    get title() { return t("task-components:inbox_94835ea2"); },
    shortcuts: [
      { keys: ["j"], get label() { return t("task-components:moveDown_40bb50da"); } },
      { keys: ["↓"], get label() { return t("task-components:moveDown_40bb50da"); } },
      { keys: ["k"], get label() { return t("task-components:moveUp_c66feb5e"); } },
      { keys: ["↑"], get label() { return t("task-components:moveUp_c66feb5e"); } },
      { keys: ["←"], get label() { return t("task-components:collapseSelectedGroup_933a60af"); } },
      { keys: ["→"], get label() { return t("task-components:expandSelectedGroup_6ecae6bf"); } },
      { keys: ["Enter"], get label() { return t("task-components:openSelectedItem_948dbc15"); } },
      { keys: ["a"], get label() { return t("task-components:archiveItem_0fd57cea"); } },
      { keys: ["y"], get label() { return t("task-components:archiveItem_0fd57cea"); } },
      { keys: ["r"], get label() { return t("task-components:markAsRead_50c8b81f"); } },
      { keys: ["U"], get label() { return t("task-components:markAsUnread_2c19d584"); } },
    ],
  },
  {
    get title() { return t("task-components:taskDetail_be4654d6"); },
    shortcuts: [
      { keys: ["y"], get label() { return t("task-components:quickArchiveBackToInbox_630428a4"); } },
      { keys: ["g", "i"], get label() { return t("task-components:goToInbox_cde5beda"); } },
      { keys: ["g", "c"], get label() { return t("task-components:focusCommentComposer_a0f6da74"); } },
    ],
  },
  {
    get title() { return t("task-components:decisions_cfa6a08a"); },
    shortcuts: [
      { keys: ["j"], get label() { return t("task-components:moveDown_40bb50da"); } },
      { keys: ["↓"], get label() { return t("task-components:moveDown_40bb50da"); } },
      { keys: ["k"], get label() { return t("task-components:moveUp_c66feb5e"); } },
      { keys: ["↑"], get label() { return t("task-components:moveUp_c66feb5e"); } },
      { keys: ["Enter"], get label() { return t("task-components:openOrCloseSelectedDecision_54d2aeda"); } },
      { keys: ["x"], get label() { return t("task-components:dismissSelectedDecision_371158fa"); } },
    ],
  },
  {
    get title() { return t("task-components:global_a258b30f"); },
    shortcuts: [
      { keys: ["/"], get label() { return t("task-components:searchCurrentPageOrQuickSearch_4dac6ee7"); } },
      { keys: ["c"], get label() { return t("task-components:newTask_3e992276"); } },
      { keys: ["["], get label() { return t("task-components:toggleSidebar_041aefc4"); } },
      { keys: ["]"], get label() { return t("task-components:togglePanel_ed988528"); } },
      { keys: ["?"], get label() { return t("task-components:showKeyboardShortcuts_3d0ced5d"); } },
    ],
  },
];

function KeyCap({ children }: { children: string }) {
  useTranslation("task-components");
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-xs font-medium text-foreground shadow-(--shadow-extract-10)">
      {children}
    </kbd>
  );
}

export function KeyboardShortcutsCheatsheetContent() {
  useTranslation("task-components");
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
                            {shortcut.combo ? "+" : t("task-components:then_21af6f12")}
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
          <Trans ns="final-components-b" i18nKey="final-components-b:shortcuts.Press_escape_to_close_Shortcuts_are_disabled_in_text_fields_c8f676" components={{ escape: <KeyCap>Esc</KeyCap> }} />
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
  useTranslation("task-components");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md gap-0 p-0 overflow-hidden" showCloseButton={false}>
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="text-base">{t("task-components:keyboardShortcuts_e9bef0b0")}</DialogTitle>
        </DialogHeader>
        <KeyboardShortcutsCheatsheetContent />
      </DialogContent>
    </Dialog>
  );
}
