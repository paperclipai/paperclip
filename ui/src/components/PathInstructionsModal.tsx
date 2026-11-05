import { t, useTranslation, Trans } from "@/i18n";
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

type Platform = "mac" | "windows" | "linux";

const platforms: { id: Platform; label: string; icon: typeof Apple }[] = [
  { id: "mac", label: "macOS", icon: Apple },
  { id: "windows", label: "Windows", icon: Monitor },
  { id: "linux", label: "Linux", icon: Terminal },
];

const instructions: Record<Platform, { steps: string[]; tip?: string }> = {
  mac: {
    steps: [
      "final-components-a:openFinderAndNavigateTo_66cacfe6",
      "final-components-a:rightClickOrControlClick_6969013c",
      "final-components-a:holdTheOptionKeyCopy_b529c1ca",
      "final-components-a:clickCopyAsPathnameThen_d72f79bb",
    ],
    get tip() { return t("final-components-a:youCanAlsoOpenTerminal_1aba1a97"); },
  },
  windows: {
    steps: [
      "final-components-a:openFileExplorerAndNavigate_6e98a6b0",
      "final-components-a:clickInTheAddressBar_a3b82898",
      "final-components-a:copyThePathThenPaste_2ba9652d",
    ],
    get tip() { return t("final-components-a:alternativelyHoldShiftAndRight_235047a2"); },
  },
  linux: {
    steps: [
      "final-components-a:openATerminalAndNavigate_71d0da92",
      "final-components-a:runPwdToPrintThe_f35cd2ce",
      "final-components-a:copyTheOutputAndPaste_35b5cc18",
    ],
    get tip() { return t("final-components-a:inMostFileManagersCtrl_4a5c2d29"); },
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
  useTranslation("task-components");
  const [platform, setPlatform] = useState<Platform>(detectPlatform);

  const current = instructions[platform];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{t("task-components:howToGetAFullPath_dc9f3a66")}</DialogTitle>
          <DialogDescription><Trans ns="task-components" i18nKey="sentence_50b96b4af226" components={{ part1: <>{<code className="text-xs bg-muted px-1 py-0.5 rounded">/Users/you/project</code>}</> }} /></DialogDescription>
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
              <span>{t(step)}</span>
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
  useTranslation("task-components");
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
      >{t("task-components:choose_c7f93783")}</button>
      <PathInstructionsModal open={open} onOpenChange={setOpen} />
    </>
  );
}
