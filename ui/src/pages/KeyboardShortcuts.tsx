import { Keyboard } from "lucide-react";

interface ShortcutEntry {
  keys: string[];
  description: string;
  scope: string;
}

const shortcuts: ShortcutEntry[] = [
  { keys: ["Ctrl/Cmd", "K"], description: "Open command palette", scope: "Global" },
  { keys: ["Ctrl/Cmd", "Enter"], description: "Submit current form or advance wizard step", scope: "Global" },
  { keys: ["Ctrl/Cmd", "N"], description: "Create new mission", scope: "Missions" },
  { keys: ["Ctrl/Cmd", "Shift", "N"], description: "Create new agent", scope: "Agents" },
  { keys: ["Escape"], description: "Close dialog or popover", scope: "Global" },
  { keys: ["?"], description: "Open keyboard shortcuts help", scope: "Global" },
  { keys: ["G", "then", "D"], description: "Go to Dashboard", scope: "Navigation" },
  { keys: ["G", "then", "A"], description: "Go to Agents", scope: "Navigation" },
  { keys: ["G", "then", "I"], description: "Go to Missions", scope: "Navigation" },
  { keys: ["G", "then", "P"], description: "Go to Projects", scope: "Navigation" },
  { keys: ["G", "then", "S"], description: "Go to Settings", scope: "Navigation" },
  { keys: ["J"], description: "Move to next item in list", scope: "Lists" },
  { keys: ["K"], description: "Move to previous item in list", scope: "Lists" },
  { keys: ["Enter"], description: "Open selected item", scope: "Lists" },
  { keys: ["Ctrl/Cmd", "/"], description: "Focus search input", scope: "Global" },
];

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 rounded border border-border bg-muted text-[11px] font-mono font-medium text-foreground/80 shadow-sm">
      {children}
    </kbd>
  );
}

export function KeyboardShortcuts() {
  const grouped = shortcuts.reduce<Record<string, ShortcutEntry[]>>((acc, entry) => {
    (acc[entry.scope] ??= []).push(entry);
    return acc;
  }, {});

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="flex items-center gap-3 mb-8">
        <div className="bg-muted/50 p-2.5 rounded-lg">
          <Keyboard className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Keyboard Shortcuts</h1>
          <p className="text-sm text-muted-foreground">
            Navigate faster with keyboard shortcuts. All shortcuts work when no input is focused.
          </p>
        </div>
      </div>

      <div className="space-y-8">
        {Object.entries(grouped).map(([scope, entries]) => (
          <div key={scope}>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
              {scope}
            </h2>
            <div className="rounded-lg border border-border divide-y divide-border">
              {entries.map((entry, idx) => (
                <div key={idx} className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm text-foreground">{entry.description}</span>
                  <div className="flex items-center gap-1">
                    {entry.keys.map((key, ki) =>
                      key === "then" ? (
                        <span key={ki} className="text-xs text-muted-foreground mx-0.5">then</span>
                      ) : (
                        <Kbd key={ki}>{key}</Kbd>
                      )
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
