import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocale } from "../context/LocaleContext";

export function RunButton({
  onClick,
  disabled,
  label,
  size = "sm",
}: {
  onClick: () => void;
  disabled?: boolean;
  label?: string;
  size?: "sm" | "default";
}) {
  const { t } = useLocale();
  return (
    <Button variant="outline" size={size} onClick={onClick} disabled={disabled}>
      <Play className="h-3.5 w-3.5 sm:mr-1" />
      <span className="hidden sm:inline">{label || t("agentActionButtons.runNow")}</span>
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
  const { t } = useLocale();
  if (isPaused) {
    return (
      <Button variant="outline" size={size} onClick={onResume} disabled={disabled}>
        <Play className="h-3.5 w-3.5 sm:mr-1" />
        <span className="hidden sm:inline">{t("agentActionButtons.resume")}</span>
      </Button>
    );
  }

  return (
    <Button variant="outline" size={size} onClick={onPause} disabled={disabled}>
      <Pause className="h-3.5 w-3.5 sm:mr-1" />
      <span className="hidden sm:inline">{t("agentActionButtons.pause")}</span>
    </Button>
  );
}
