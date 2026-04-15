import { useState, useEffect, useRef, useMemo } from "react";
import { cn } from "../lib/utils";
import { Keyboard, Search, X } from "lucide-react";

interface Shortcut {
  keys: string[];
  description: string;
  category: string;
  scope?: string;
}

const SHORTCUTS: Shortcut[] = [
  // Navigation
  { keys: ["Ctrl", "K"], description: "Open command palette", category: "Navigation" },
  { keys: ["Ctrl", "."], description: "Open / cycle chat agent", category: "Navigation" },
  { keys: ["Esc"], description: "Close chat / modal", category: "Navigation" },
  { keys: ["C"], description: "Create new issue", category: "Navigation" },
  { keys: ["["], description: "Toggle sidebar", category: "Navigation" },
  { keys: ["]"], description: "Toggle properties panel", category: "Navigation" },

  // Issue page
  { keys: ["T"], description: "Scroll to top", category: "Issue Page", scope: "Issue detail" },
  { keys: ["D"], description: "Scroll to documents", category: "Issue Page", scope: "Issue detail" },
  { keys: ["N"], description: "Scroll to newest comment", category: "Issue Page", scope: "Issue detail" },

  // Modals
  { keys: ["Ctrl", "Shift", "K"], description: "Open command modal", category: "Modals" },
  { keys: ["Ctrl", "Shift", "P"], description: "Open quick notes", category: "Modals" },
  { keys: ["Shift", "?"], description: "Show keyboard shortcuts", category: "Modals" },
];

function KeyBadge({ text }: { text: string }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 rounded border border-border bg-muted text-xs font-mono font-medium text-foreground shadow-sm">
      {text}
    </kbd>
  );
}

export function KeyboardShortcutsModal() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;

      if (e.key === "?" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      setSearch("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const filtered = useMemo(() => {
    if (!search.trim()) return SHORTCUTS;
    const q = search.toLowerCase();
    return SHORTCUTS.filter(
      (s) =>
        s.description.toLowerCase().includes(q) ||
        s.keys.join(" ").toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q),
    );
  }, [search]);

  const categories = useMemo(() => {
    const cats = new Map<string, Shortcut[]>();
    for (const s of filtered) {
      const list = cats.get(s.category) ?? [];
      list.push(s);
      cats.set(s.category, list);
    }
    return cats;
  }, [filtered]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" onClick={() => setOpen(false)} />

      <div className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2">
        <div className="rounded-xl border border-border bg-card shadow-2xl overflow-hidden flex flex-col max-h-[70vh]">
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-muted/30 shrink-0">
            <Keyboard className="h-4 w-4 text-primary shrink-0" />
            <span className="text-sm font-medium flex-1">Keyboard Shortcuts</span>
            <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Search */}
          <div className="px-4 py-2 border-b border-border shrink-0">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Search className="h-3.5 w-3.5 shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search shortcuts..."
                className="flex-1 bg-transparent text-sm outline-none text-foreground placeholder:text-muted-foreground"
              />
            </div>
          </div>

          {/* Shortcuts list */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
            {categories.size === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No shortcuts match your search.</p>
            ) : (
              Array.from(categories.entries()).map(([category, shortcuts]) => (
                <div key={category}>
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                    {category}
                  </h3>
                  <div className="space-y-1">
                    {shortcuts.map((s) => (
                      <div
                        key={s.keys.join("+")}
                        className="flex items-center justify-between py-1.5 text-sm"
                      >
                        <span className="text-foreground/90">
                          {s.description}
                          {s.scope && (
                            <span className="text-xs text-muted-foreground ml-1.5">({s.scope})</span>
                          )}
                        </span>
                        <div className="flex items-center gap-1 shrink-0 ml-3">
                          {s.keys.map((key, i) => (
                            <span key={i} className="flex items-center gap-0.5">
                              {i > 0 && <span className="text-xs text-muted-foreground mx-0.5">+</span>}
                              <KeyBadge text={key} />
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t border-border bg-muted/20 text-xs text-muted-foreground shrink-0">
            Press <KeyBadge text="?" /> to toggle this modal
          </div>
        </div>
      </div>
    </>
  );
}
