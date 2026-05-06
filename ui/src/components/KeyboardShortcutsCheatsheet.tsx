import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface ShortcutEntry {
  keys: string[];
  label: string;
}

interface ShortcutSection {
  title: string;
  shortcuts: ShortcutEntry[];
}

function buildSections(t: TFunction): ShortcutSection[] {
  return [
    {
      title: t("keyboard_shortcuts.section_inbox"),
      shortcuts: [
        { keys: ["j"], label: t("keyboard_shortcuts.move_down") },
        { keys: ["↓"], label: t("keyboard_shortcuts.move_down") },
        { keys: ["k"], label: t("keyboard_shortcuts.move_up") },
        { keys: ["↑"], label: t("keyboard_shortcuts.move_up") },
        { keys: ["←"], label: t("keyboard_shortcuts.collapse_group") },
        { keys: ["→"], label: t("keyboard_shortcuts.expand_group") },
        { keys: ["Enter"], label: t("keyboard_shortcuts.open_item") },
        { keys: ["a"], label: t("keyboard_shortcuts.archive_item") },
        { keys: ["y"], label: t("keyboard_shortcuts.archive_item") },
        { keys: ["r"], label: t("keyboard_shortcuts.mark_as_read") },
        { keys: ["U"], label: t("keyboard_shortcuts.mark_as_unread") },
      ],
    },
    {
      title: t("keyboard_shortcuts.section_issue_detail"),
      shortcuts: [
        { keys: ["y"], label: t("keyboard_shortcuts.quick_archive") },
        { keys: ["g", "i"], label: t("keyboard_shortcuts.go_to_inbox") },
        { keys: ["g", "c"], label: t("keyboard_shortcuts.focus_comment") },
      ],
    },
    {
      title: t("keyboard_shortcuts.section_global"),
      shortcuts: [
        { keys: ["/"], label: t("keyboard_shortcuts.search_or_quick") },
        { keys: ["c"], label: t("keyboard_shortcuts.new_issue") },
        { keys: ["["], label: t("keyboard_shortcuts.toggle_sidebar") },
        { keys: ["]"], label: t("keyboard_shortcuts.toggle_panel") },
        { keys: ["?"], label: t("keyboard_shortcuts.show_shortcuts") },
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
  const { t } = useTranslation("common");
  const sections = useMemo(() => buildSections(t), [t]);
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
                        {i > 0 && <span className="text-xs text-muted-foreground">{t("keyboard_shortcuts.then")}</span>}
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
          {t("keyboard_shortcuts.footer_press")} <KeyCap>Esc</KeyCap> {t("keyboard_shortcuts.footer_to_close")} &middot; {t("keyboard_shortcuts.footer_disabled_in_text")}
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
          <DialogTitle className="text-base">{t("keyboard_shortcuts.title")}</DialogTitle>
        </DialogHeader>
        <KeyboardShortcutsCheatsheetContent />
      </DialogContent>
    </Dialog>
  );
}
