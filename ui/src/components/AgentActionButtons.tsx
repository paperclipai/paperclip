import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { agentDetailUi } from "../lib/i18n";

export function RunButton({
  onClick,
  disabled,
  label = agentDetailUi.runNowButtonLabel,
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
  pauseLabel = agentDetailUi.pauseAgentButton,
  resumeLabel = agentDetailUi.resumeAgentButton,
}: {
  isPaused: boolean;
  onPause: () => void;
  onResume: () => void;
  disabled?: boolean;
  size?: "sm" | "default";
  pauseLabel?: string;
  resumeLabel?: string;
}) {
  if (isPaused) {
    return (
      <Button variant="outline" size={size} onClick={onResume} disabled={disabled}>
        <Play className="h-3.5 w-3.5 sm:mr-1" />
        <span className="hidden sm:inline">{resumeLabel}</span>
      </Button>
    );
  }

  return (
    <Button variant="outline" size={size} onClick={onPause} disabled={disabled}>
      <Pause className="h-3.5 w-3.5 sm:mr-1" />
      <span className="hidden sm:inline">{pauseLabel}</span>
    </Button>
  );
}
