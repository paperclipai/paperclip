import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import i18n from "@/i18n";
interface ShortcutEntry {
  keys: string[];
  label: string;
}

interface ShortcutSection {
  title: string;
  shortcuts: ShortcutEntry[];
}

const sections: ShortcutSection[] = [
  {
    title: "Inbox",
    shortcuts: [
      { keys: ["j"], label: i18n.t("components.KeyboardShortcutsCheatsheet.label") },
      { keys: ["↓"], label: i18n.t("components.KeyboardShortcutsCheatsheet.label_1") },
      { keys: ["k"], label: i18n.t("components.KeyboardShortcutsCheatsheet.label_2") },
      { keys: ["↑"], label: i18n.t("components.KeyboardShortcutsCheatsheet.label_3") },
      { keys: ["←"], label: i18n.t("components.KeyboardShortcutsCheatsheet.label_4") },
      { keys: ["→"], label: i18n.t("components.KeyboardShortcutsCheatsheet.label_5") },
      { keys: ["Enter"], label: i18n.t("components.KeyboardShortcutsCheatsheet.label_6") },
      { keys: ["a"], label: i18n.t("components.KeyboardShortcutsCheatsheet.label_7") },
      { keys: ["y"], label: i18n.t("components.KeyboardShortcutsCheatsheet.label_8") },
      { keys: ["r"], label: i18n.t("components.KeyboardShortcutsCheatsheet.label_9") },
      { keys: ["U"], label: i18n.t("components.KeyboardShortcutsCheatsheet.label_10") },
    ],
  },
  {
    title: i18n.t("components.KeyboardShortcutsCheatsheet.title"),
    shortcuts: [
      { keys: ["y"], label: i18n.t("components.KeyboardShortcutsCheatsheet.label_11") },
      { keys: ["g", "i"], label: i18n.t("components.KeyboardShortcutsCheatsheet.label_12") },
      { keys: ["g", "c"], label: i18n.t("components.KeyboardShortcutsCheatsheet.label_13") },
    ],
  },
  {
    title: "Global",
    shortcuts: [
      { keys: ["/"], label: i18n.t("components.KeyboardShortcutsCheatsheet.label_14") },
      { keys: ["c"], label: i18n.t("components.KeyboardShortcutsCheatsheet.label_15") },
      { keys: ["["], label: i18n.t("components.KeyboardShortcutsCheatsheet.label_16") },
      { keys: ["]"], label: i18n.t("components.KeyboardShortcutsCheatsheet.label_17") },
      { keys: ["?"], label: i18n.t("components.KeyboardShortcutsCheatsheet.label_18") },
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
                        {i > 0 && <span className="text-xs text-muted-foreground">{i18n.t("components.KeyboardShortcutsCheatsheet.span")}</span>}
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
          Press <KeyCap>Esc</KeyCap> to close &middot; Shortcuts are disabled in text fields
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
          <DialogTitle className="text-base">{i18n.t("components.KeyboardShortcutsCheatsheet.dialogtitle")}</DialogTitle>
        </DialogHeader>
        <KeyboardShortcutsCheatsheetContent />
      </DialogContent>
    </Dialog>
  );
}
