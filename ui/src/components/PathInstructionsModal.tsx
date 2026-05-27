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
import { useTranslation } from "@/i18n";

type Platform = "mac" | "windows" | "linux";

const platforms: { id: Platform; icon: typeof Apple }[] = [
  { id: "mac", icon: Apple },
  { id: "windows", icon: Monitor },
  { id: "linux", icon: Terminal },
];

const getInstructions = (t: (key: string) => string) => ({
  mac: {
    steps: [
      t("pages.pathInstructions.macosStep1"),
      t("pages.pathInstructions.macosStep2"),
      t("pages.pathInstructions.macosStep3"),
      t("pages.pathInstructions.macosStep4"),
    ],
    tip: t("pages.pathInstructions.macosTip"),
  },
  windows: {
    steps: [
      t("pages.pathInstructions.windowsStep1"),
      t("pages.pathInstructions.windowsStep2"),
      t("pages.pathInstructions.windowsStep3"),
    ],
    tip: t("pages.pathInstructions.windowsTip"),
  },
  linux: {
    steps: [
      t("pages.pathInstructions.linuxStep1"),
      t("pages.pathInstructions.linuxStep2"),
      t("pages.pathInstructions.linuxStep3"),
    ],
    tip: t("pages.pathInstructions.linuxTip"),
  },
});

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
  const instructions = getInstructions(t);

  const current = instructions[platform];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{t("pages.pathInstructions.title")}</DialogTitle>
          <DialogDescription>
            {t("pages.pathInstructions.description")}
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
              {t(`pages.pathInstructions.${p.id === "mac" ? "macos" : p.id}`)}
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
        {t("pages.pathInstructions.choose")}
      </button>
      <PathInstructionsModal open={open} onOpenChange={setOpen} />
    </>
  );
}
