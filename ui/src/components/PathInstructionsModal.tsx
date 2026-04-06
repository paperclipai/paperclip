import { useMemo, useState } from "react";
import { useTranslation } from "@/i18n";
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

  const platforms: { id: Platform; label: string; icon: typeof Apple }[] = useMemo(
    () => [
      { id: "mac", label: t("components.pathInstructionsModal.platforms.mac"), icon: Apple },
      { id: "windows", label: t("components.pathInstructionsModal.platforms.windows"), icon: Monitor },
      { id: "linux", label: t("components.pathInstructionsModal.platforms.linux"), icon: Terminal },
    ],
    [t],
  );

  const instructions: Record<Platform, { steps: string[]; tip?: string }> = useMemo(
    () => ({
      mac: {
        steps: [
          t("components.pathInstructionsModal.instructions.mac.steps.1"),
          t("components.pathInstructionsModal.instructions.mac.steps.2"),
          t("components.pathInstructionsModal.instructions.mac.steps.3"),
          t("components.pathInstructionsModal.instructions.mac.steps.4"),
        ],
        tip: t("components.pathInstructionsModal.instructions.mac.tip"),
      },
      windows: {
        steps: [
          t("components.pathInstructionsModal.instructions.windows.steps.1"),
          t("components.pathInstructionsModal.instructions.windows.steps.2"),
          t("components.pathInstructionsModal.instructions.windows.steps.3"),
        ],
        tip: t("components.pathInstructionsModal.instructions.windows.tip"),
      },
      linux: {
        steps: [
          t("components.pathInstructionsModal.instructions.linux.steps.1"),
          t("components.pathInstructionsModal.instructions.linux.steps.2"),
          t("components.pathInstructionsModal.instructions.linux.steps.3"),
        ],
        tip: t("components.pathInstructionsModal.instructions.linux.tip"),
      },
    }),
    [t],
  );

  const current = instructions[platform];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{t("components.pathInstructionsModal.title")}</DialogTitle>
          <DialogDescription>
            {t("components.pathInstructionsModal.description")}{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">/Users/you/project</code>
            .
          </DialogDescription>
        </DialogHeader>

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

        {current.tip ? (
          <p className="text-xs text-muted-foreground border-l-2 border-border pl-3">
            {current.tip}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

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
        {t("components.pathInstructionsModal.choose")}
      </button>
      <PathInstructionsModal open={open} onOpenChange={setOpen} />
    </>
  );
}
