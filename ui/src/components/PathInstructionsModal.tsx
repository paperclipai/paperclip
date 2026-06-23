import { useState } from "react";
import { Apple, Monitor, Terminal } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { t, useTranslation } from "@/i18n";

type Platform = "mac" | "windows" | "linux";

const platforms: { id: Platform; label: string; icon: typeof Apple }[] = [
  { id: "mac", label: "macOS", icon: Apple },
  { id: "windows", label: "Windows", icon: Monitor },
  { id: "linux", label: "Linux", icon: Terminal },
];

function getInstructions(): Record<
  Platform,
  { steps: string[]; tip?: string }
> {
  return {
    mac: {
      steps: [
        t("components.pathInstructionsModal.macStep1", {
          defaultValue: "Open Finder and navigate to the folder.",
        }),
        t("components.pathInstructionsModal.macStep2", {
          defaultValue: "Right-click (or Control-click) the folder.",
        }),
        t("components.pathInstructionsModal.macStep3", {
          defaultValue:
            'Hold the Option (⌥) key — "Copy" changes to "Copy as Pathname".',
        }),
        t("components.pathInstructionsModal.macStep4", {
          defaultValue: 'Click "Copy as Pathname", then paste here.',
        }),
      ],
      tip: t("components.pathInstructionsModal.macTip", {
        defaultValue:
          "You can also open Terminal, type cd, drag the folder into the terminal window, and press Enter. Then type pwd to see the full path.",
      }),
    },
    windows: {
      steps: [
        t("components.pathInstructionsModal.windowsStep1", {
          defaultValue: "Open File Explorer and navigate to the folder.",
        }),
        t("components.pathInstructionsModal.windowsStep2", {
          defaultValue:
            "Click in the address bar at the top — the full path will appear.",
        }),
        t("components.pathInstructionsModal.windowsStep3", {
          defaultValue: "Copy the path, then paste here.",
        }),
      ],
      tip: t("components.pathInstructionsModal.windowsTip", {
        defaultValue:
          'Alternatively, hold Shift and right-click the folder, then select "Copy as path".',
      }),
    },
    linux: {
      steps: [
        t("components.pathInstructionsModal.linuxStep1", {
          defaultValue: "Open a terminal and navigate to the directory with cd.",
        }),
        t("components.pathInstructionsModal.linuxStep2", {
          defaultValue: "Run pwd to print the full path.",
        }),
        t("components.pathInstructionsModal.linuxStep3", {
          defaultValue: "Copy the output and paste here.",
        }),
      ],
      tip: t("components.pathInstructionsModal.linuxTip", {
        defaultValue:
          "In most file managers, Ctrl+L reveals the full path in the address bar.",
      }),
    },
  };
}

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
  const { t } = useTranslation();
  const [platform, setPlatform] = useState<Platform>(detectPlatform);

  const current = getInstructions()[platform];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">
            {t("components.pathInstructionsModal.title", {
              defaultValue: "How to get a full path",
            })}
          </DialogTitle>
          <DialogDescription>
            {t("components.pathInstructionsModal.descriptionPrefix", {
              defaultValue: "Paste the absolute path (e.g.",
            })}{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">/Users/you/project</code>
            {t("components.pathInstructionsModal.descriptionSuffix", {
              defaultValue: ") into the input field.",
            })}
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
 * Small "Choose" button that opens the PathInstructionsModal.
 * Drop-in replacement for the old showDirectoryPicker buttons.
 */
export function ChoosePathButton({ className }: { className?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
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
        {t("components.pathInstructionsModal.chooseButton", {
          defaultValue: "Choose",
        })}
      </button>
      <PathInstructionsModal open={open} onOpenChange={setOpen} />
    </>
  );
}
