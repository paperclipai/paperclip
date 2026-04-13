import { useEffect, useState } from "react";
import type { RoutineTrigger } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { ScheduleEditor } from "./ScheduleEditor";

const triggerKinds = ["schedule", "webhook"] as const;
const signingModes = ["bearer", "hmac_sha256", "github_hmac", "none"] as const;
const SIGNING_MODES_WITHOUT_REPLAY_WINDOW = new Set<string>(["github_hmac", "none"]);
const signingModeDescriptions: Record<string, string> = {
  bearer: "Expect a shared bearer token in the Authorization header.",
  hmac_sha256: "Expect an HMAC SHA-256 signature over the request using the shared secret.",
  github_hmac: "Accept GitHub-style X-Hub-Signature-256 header (HMAC over raw body, no timestamp).",
  none: "No authentication — the webhook URL itself acts as a shared secret.",
};

type TriggerKind = (typeof triggerKinds)[number];

export interface TriggerDialogState {
  label: string;
  kind: TriggerKind;
  cronExpression: string;
  signingMode: string;
  replayWindowSec: string;
  enabled: boolean;
}

interface TriggerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When editing an existing trigger, pass it here. Null for create. */
  trigger: RoutineTrigger | null;
  /** Timezone to use when creating a new schedule trigger (the detail page uses the browser's zone). */
  fallbackTimezone: string;
  /** Called when the user submits. For updates `id` is non-null. */
  onSubmit: (payload: {
    id: string | null;
    kind: TriggerKind;
    // For create: full body. For update: partial patch ready to send.
    body: Record<string, unknown>;
  }) => void;
  submitting?: boolean;
}

const BLANK: TriggerDialogState = {
  label: "",
  kind: "schedule",
  cronExpression: "0 9 * * 1-5",
  signingMode: "bearer",
  replayWindowSec: "300",
  enabled: true,
};

function draftFromTrigger(trigger: RoutineTrigger | null): TriggerDialogState {
  if (!trigger) return { ...BLANK };
  return {
    label: trigger.label ?? "",
    kind: (trigger.kind as TriggerKind) ?? "schedule",
    cronExpression: trigger.cronExpression ?? "0 9 * * 1-5",
    signingMode: trigger.signingMode ?? "bearer",
    replayWindowSec: String(trigger.replayWindowSec ?? 300),
    enabled: trigger.enabled,
  };
}

function parseReplayWindowSec(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return 300;
  return Math.trunc(parsed);
}

export function TriggerDialog({
  open,
  onOpenChange,
  trigger,
  fallbackTimezone,
  onSubmit,
  submitting,
}: TriggerDialogProps) {
  const isEdit = !!trigger;
  const [draft, setDraft] = useState<TriggerDialogState>(() => draftFromTrigger(trigger));

  // Reset the draft whenever the dialog opens with a different trigger.
  useEffect(() => {
    if (open) setDraft(draftFromTrigger(trigger));
  }, [open, trigger]);

  const handleSubmit = () => {
    const labelTrimmed = draft.label.trim();

    if (isEdit && trigger) {
      // Build a PATCH body. Match the fields the backend accepts on
      // PATCH /routine-triggers/:id (see updateRoutineTriggerSchema).
      const patch: Record<string, unknown> = {
        label: labelTrimmed || null,
        enabled: draft.enabled,
      };
      if (trigger.kind === "schedule") {
        patch.cronExpression = draft.cronExpression.trim();
        patch.timezone = trigger.timezone ?? fallbackTimezone;
      }
      if (trigger.kind === "webhook") {
        patch.signingMode = draft.signingMode;
        patch.replayWindowSec = parseReplayWindowSec(draft.replayWindowSec);
      }
      onSubmit({ id: trigger.id, kind: trigger.kind as TriggerKind, body: patch });
      return;
    }

    // Create body: match POST /routines/:id/triggers (createRoutineTriggerSchema).
    const body: Record<string, unknown> = {
      kind: draft.kind,
      label: labelTrimmed || draft.kind,
    };
    if (draft.kind === "schedule") {
      body.cronExpression = draft.cronExpression.trim();
      body.timezone = fallbackTimezone;
    }
    if (draft.kind === "webhook") {
      body.signingMode = draft.signingMode;
      body.replayWindowSec = parseReplayWindowSec(draft.replayWindowSec);
    }
    onSubmit({ id: null, kind: draft.kind, body });
  };

  const showWebhookFields = draft.kind === "webhook";
  const showScheduleFields = draft.kind === "schedule";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit trigger" : "Add trigger"}</DialogTitle>
          <DialogDescription>
            Configure when and how this routine fires.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 pt-1">
          <div className="space-y-1.5">
            <Label htmlFor="trigger-label" className="text-xs">Label</Label>
            <Input
              id="trigger-label"
              placeholder="e.g. Morning digest"
              value={draft.label}
              onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">
              Optional — shown in the trigger list.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Kind</Label>
            <Select
              value={draft.kind}
              onValueChange={(kind) => setDraft((d) => ({ ...d, kind: kind as TriggerKind }))}
              disabled={isEdit}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {triggerKinds.map((kind) => (
                  <SelectItem
                    key={kind}
                    value={kind}
                    disabled={!isEdit && kind === "webhook"}
                  >
                    {kind}
                    {!isEdit && kind === "webhook" ? " — COMING SOON" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isEdit && (
              <p className="text-xs text-muted-foreground">
                Kind can't be changed after creation.
              </p>
            )}
          </div>

          {showScheduleFields && (
            <ScheduleEditor
              value={draft.cronExpression}
              onChange={(cronExpression) => setDraft((d) => ({ ...d, cronExpression }))}
            />
          )}

          {showWebhookFields && (
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Signing mode</Label>
                <Select
                  value={draft.signingMode}
                  onValueChange={(signingMode) => setDraft((d) => ({ ...d, signingMode }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {signingModes.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {mode}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {signingModeDescriptions[draft.signingMode]}
                </p>
              </div>
              {!SIGNING_MODES_WITHOUT_REPLAY_WINDOW.has(draft.signingMode) && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Replay window (seconds)</Label>
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    value={draft.replayWindowSec}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, replayWindowSec: e.target.value }))
                    }
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="mt-6">
          {isEdit && (
            <label className="flex items-center gap-2 cursor-pointer text-sm mr-auto">
              <ToggleSwitch
                checked={draft.enabled}
                onCheckedChange={(enabled) => setDraft((d) => ({ ...d, enabled }))}
              />
              <span>{draft.enabled ? "Enabled" : "Paused"}</span>
            </label>
          )}
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Saving…" : isEdit ? "Save changes" : "Add trigger"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
