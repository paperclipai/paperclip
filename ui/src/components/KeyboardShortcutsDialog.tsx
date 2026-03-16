import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  groupedShortcuts,
  categoryLabel,
  formatKeys,
  type Shortcut,
} from "@/lib/keyboard-shortcuts";

interface KeyboardShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function Kbd({ keys }: { keys: string }) {
  const parts = formatKeys(keys);
  return (
    <span className="flex items-center gap-0.5">
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && keys.includes(",") && (
            <span className="mx-0.5 text-muted-foreground text-[10px]">then</span>
          )}
          <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-[11px] font-medium text-foreground">
            {part}
          </kbd>
        </span>
      ))}
    </span>
  );
}

function ShortcutRow({ shortcut }: { shortcut: Shortcut }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm text-foreground">{shortcut.label}</span>
      <Kbd keys={shortcut.keys} />
    </div>
  );
}

export function KeyboardShortcutsDialog({ open, onOpenChange }: KeyboardShortcutsDialogProps) {
  const groups = groupedShortcuts();
  const categoryOrder: Shortcut["category"][] = ["navigation", "actions", "list", "ui"];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="text-sm font-semibold">Keyboard shortcuts</DialogTitle>
          <DialogDescription className="sr-only">
            All available keyboard shortcuts
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto px-5 pb-5">
          <div className="space-y-4">
            {categoryOrder.map((cat) => {
              const shortcuts = groups[cat];
              if (shortcuts.length === 0) return null;
              return (
                <div key={cat}>
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                    {categoryLabel(cat)}
                  </h3>
                  <div className="divide-y divide-border">
                    {shortcuts.map((s) => (
                      <ShortcutRow key={s.id} shortcut={s} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
