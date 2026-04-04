import { useRef, useState } from "react";
import { Apple, Monitor, Terminal } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Platform = "mac" | "windows" | "linux";

const platforms: { id: Platform; label: string; icon: typeof Apple }[] = [
  { id: "mac", label: "macOS", icon: Apple },
  { id: "windows", label: "Windows", icon: Monitor },
  { id: "linux", label: "Linux", icon: Terminal },
];

const instructions: Record<Platform, { steps: string[]; tip?: string }> = {
  mac: {
    steps: [
      "Open Finder and navigate to the folder.",
      "Right-click (or Control-click) the folder.",
      "Hold the Option (⌥) key — \"Copy\" changes to \"Copy as Pathname\".",
      "Click \"Copy as Pathname\", then paste here.",
    ],
    tip: "You can also open Terminal, type cd, drag the folder into the terminal window, and press Enter. Then type pwd to see the full path.",
  },
  windows: {
    steps: [
      "Open File Explorer and navigate to the folder.",
      "Click in the address bar at the top — the full path will appear.",
      "Copy the path, then paste here.",
    ],
    tip: "Alternatively, hold Shift and right-click the folder, then select \"Copy as path\".",
  },
  linux: {
    steps: [
      "Open a terminal and navigate to the directory with cd.",
      "Run pwd to print the full path.",
      "Copy the output and paste here.",
    ],
    tip: "In most file managers, Ctrl+L reveals the full path in the address bar.",
  },
};

function detectPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return "mac";
  if (ua.includes("win")) return "windows";
  return "linux";
}

interface PathInstructionsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PathInstructionsModal({
  open,
  onOpenChange,
}: PathInstructionsModalProps) {
  const [platform, setPlatform] = useState<Platform>(detectPlatform);

  const current = instructions[platform];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">How to get a full path</DialogTitle>
          <DialogDescription>
            Paste the absolute path (e.g.{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">/Users/you/project</code>
            ) into the input field.
          </DialogDescription>
        </DialogHeader>

        {/* Platform tabs */}
        <div className="flex gap-1 rounded-md border border-border p-0.5">
          {platforms.map((p) => (
            <button
              key={p.id}
              type="button"
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
                platform === p.id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
              )}
              onClick={() => setPlatform(p.id)}
            >
              <p.icon className="h-3.5 w-3.5" />
              {p.label}
            </button>
          ))}
        </div>

        {/* Steps */}
        <ol className="space-y-2 text-sm">
          {current.steps.map((step, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-muted-foreground font-mono text-xs mt-0.5 shrink-0">
                {i + 1}.
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>

        {current.tip && (
          <p className="text-xs text-muted-foreground border-l-2 border-border pl-3">
            {current.tip}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Programmatically set a React-controlled input's value by going through the
 * native setter so React's synthetic onChange fires.
 */
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Small "Choose" button that opens a native OS folder picker when the server
 * supports it, falling back to the PathInstructionsModal otherwise.
 *
 * When `onPick` is provided, the selected path is forwarded to the caller.
 * When omitted, the component finds the nearest sibling `<input>` inside the
 * same parent container and sets its value automatically.
 */
export function ChoosePathButton({
  className,
  onPick,
}: {
  className?: string;
  onPick?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  function applyPath(path: string) {
    if (onPick) {
      onPick(path);
      return;
    }
    // Auto-fill the nearest sibling input in the same container
    const input = buttonRef.current
      ?.parentElement?.querySelector("input") as HTMLInputElement | null;
    if (input) {
      setInputValue(input, path);
    }
  }

  async function handleClick() {
    try {
      setPicking(true);
      const res = await fetch("/api/folder-picker", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        if (data.path) {
          applyPath(data.path);
          return;
        }
      }
    } catch {
      // Server doesn't support native picker — fall through to modal
    } finally {
      setPicking(false);
    }
    setOpen(true);
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={picking}
        className={cn(
          "inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0",
          className,
        )}
        onClick={handleClick}
      >
        {picking ? "Opening…" : "Choose"}
      </button>
      <PathInstructionsModal open={open} onOpenChange={setOpen} />
    </>
  );
}
