import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocalizedCopy } from "@/i18n/ui-copy";

export function RunButton({
  onClick,
  disabled,
  label = "Run now",
  size = "sm",
}: {
  onClick: () => void;
  disabled?: boolean;
  label?: string;
  size?: "sm" | "default";
}) {
  return (
    <Button variant="outline" size={size} onClick={onClick} disabled={disabled}>
      <Play className="h-3.5 w-3.5 sm:mr-1" />
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}

export function PauseResumeButton({
  isPaused,
  onPause,
  onResume,
  disabled,
  size = "sm",
}: {
  isPaused: boolean;
  onPause: () => void;
  onResume: () => void;
  disabled?: boolean;
  size?: "sm" | "default";
}) {
  const copy = useLocalizedCopy();

  if (isPaused) {
    return (
      <Button variant="outline" size={size} onClick={onResume} disabled={disabled}>
        <Play className="h-3.5 w-3.5 sm:mr-1" />
        <span className="hidden sm:inline">{copy("agentActions.resume", "Resume", "재개")}</span>
      </Button>
    );
  }

  return (
    <Button variant="outline" size={size} onClick={onPause} disabled={disabled}>
      <Pause className="h-3.5 w-3.5 sm:mr-1" />
      <span className="hidden sm:inline">{copy("agentActions.pause", "Pause", "일시정지")}</span>
    </Button>
  );
}
