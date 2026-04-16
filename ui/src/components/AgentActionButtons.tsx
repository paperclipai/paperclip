import { Loader2, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

export function RunButton({
  onClick,
  disabled,
  pending,
  label = "Run now",
  size = "sm",
}: {
  onClick: () => void;
  disabled?: boolean;
  pending?: boolean;
  label?: string;
  size?: "sm" | "default";
}) {
  return (
    <Button
      variant="outline"
      size={size}
      onClick={onClick}
      disabled={disabled || pending}
      aria-label={pending ? "Starting heartbeat" : label}
    >
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin sm:mr-1" /> : <Play className="h-3.5 w-3.5 sm:mr-1" />}
      <span className="hidden sm:inline">{pending ? "Starting..." : label}</span>
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
  if (isPaused) {
    return (
      <Button variant="outline" size={size} onClick={onResume} disabled={disabled}>
        <Play className="h-3.5 w-3.5 sm:mr-1" />
        <span className="hidden sm:inline">Resume</span>
      </Button>
    );
  }

  return (
    <Button variant="outline" size={size} onClick={onPause} disabled={disabled}>
      <Pause className="h-3.5 w-3.5 sm:mr-1" />
      <span className="hidden sm:inline">Pause</span>
    </Button>
  );
}
