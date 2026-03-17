import { useState } from "react";
import { Apple, Monitor, Terminal } from "lucide-react";
import { FolderPickerDialog } from "./FolderPickerDialog";
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
 * "Choose" button that opens a native folder picker dialog.
 * Falls back to path instructions modal when no onSelect callback is provided.
 */
export function ChoosePathButton({
  className,
  onSelect,
  currentPath,
}: {
  className?: string;
  onSelect?: (path: string) => void;
  currentPath?: string;
}) {
  const [open, setOpen] = useState(false);

  if (onSelect) {
    return (
      <>
        <button
          type="button"
          className={cn(
            "inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0",
            className,
          )}
          onClick={() => setOpen(true)}
        >
          Browse
        </button>
        <FolderPickerDialog
          open={open}
          onOpenChange={setOpen}
          onSelect={onSelect}
          initialPath={currentPath}
        />
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        className={cn(
          "inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0",
          className,
        )}
        onClick={() => setOpen(true)}
      >
        Choose
      </button>
      <PathInstructionsModal open={open} onOpenChange={setOpen} />
    </>
  );
}
