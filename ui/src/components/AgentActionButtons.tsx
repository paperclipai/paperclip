import { Pause, Play } from "lucide-react";
import { Button } from "@heroui/react";

export function RunButton({
  onPress,
  isDisabled,
  label = "Run now",
  size = "sm",
}: {
  onPress: () => void;
  isDisabled?: boolean;
  label?: string;
  size?: "sm" | "md";
}) {
  return (
    <Button variant="outline" size={size} onPress={onPress} isDisabled={isDisabled}>
      <Play className="h-3.5 w-3.5 sm:mr-1" />
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}

export function PauseResumeButton({
  isPaused,
  onPause,
  onResume,
  isDisabled,
  size = "sm",
}: {
  isPaused: boolean;
  onPause: () => void;
  onResume: () => void;
  isDisabled?: boolean;
  size?: "sm" | "md";
}) {
  if (isPaused) {
    return (
      <Button variant="outline" size={size} onPress={onResume} isDisabled={isDisabled}>
        <Play className="h-3.5 w-3.5 sm:mr-1" />
        <span className="hidden sm:inline">Resume</span>
      </Button>
    );
  }

  return (
    <Button variant="outline" size={size} onPress={onPause} isDisabled={isDisabled}>
      <Pause className="h-3.5 w-3.5 sm:mr-1" />
      <span className="hidden sm:inline">Pause</span>
    </Button>
  );
}
