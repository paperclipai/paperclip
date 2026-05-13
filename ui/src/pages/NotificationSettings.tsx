import { useEffect } from "react";
import { Bell, Volume2 } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useNotificationSounds } from "../context/NotificationSoundsContext";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "../lib/utils";

function SettingRow({
  label,
  description,
  checked,
  onCheckedChange,
  onTest,
  testLabel,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (val: boolean) => void;
  onTest: () => void;
  testLabel: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-4">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium leading-none">{label}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn("h-7 px-2.5 text-xs", !checked && "opacity-50")}
          disabled={!checked}
          onClick={onTest}
        >
          <Volume2 className="mr-1 size-3" />
          {testLabel}
        </Button>
        <ToggleSwitch checked={checked} onCheckedChange={onCheckedChange} />
      </div>
    </div>
  );
}

export function NotificationSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { prefs, setPrefs, triggerCue } = useNotificationSounds();

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "Notifications" },
    ]);
  }, [setBreadcrumbs]);

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Bell className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Notifications</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Configure audible cues for task completion and attention events.
          Sounds are stored in your browser and only play in the active tab.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Sound cues</h2>
        </div>
        <div className="divide-y px-4">
          <SettingRow
            label="Task completion sound"
            description="Play a soft chime when an issue assigned to you moves to Done."
            checked={prefs.notificationSoundsEnabled}
            onCheckedChange={(val) => setPrefs({ notificationSoundsEnabled: val })}
            onTest={() => triggerCue("done")}
            testLabel="Test"
          />
          <SettingRow
            label="Attention sound"
            description="Play a two-tone alert when something needs your input — a confirmation request, @mention, or issue moving to review."
            checked={prefs.attentionSoundsEnabled}
            onCheckedChange={(val) => setPrefs({ attentionSoundsEnabled: val })}
            onTest={() => triggerCue("attention")}
            testLabel="Test"
          />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        If sounds do not play, click anywhere on the page first — browsers require
        a user interaction before allowing audio playback.
      </p>
    </div>
  );
}
