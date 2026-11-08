import { t, useTranslation } from "@/i18n";
import { useEffect, useState } from "react";
import { Clock3, RefreshCw, Save, Trash2, Webhook, Zap } from "lucide-react";
import type { RoutineTrigger } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScheduleEditor } from "./ScheduleEditor";
import { buildRoutineTriggerPatch } from "../lib/routine-trigger-patch";
import { describeCron } from "../lib/cron-readable";

const signingModes = ["app_webhook", "bearer", "hmac_sha256", "github_hmac", "none"];
const SIGNING_MODES_WITHOUT_REPLAY_WINDOW = new Set(["app_webhook", "bearer", "github_hmac", "fireflies_hmac", "none"]);

function getLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/**
 * Single trigger card with its own field-edit + save state (§3.2). Extracted
 * from the previous inline `TriggerEditor` in `RoutineDetail.tsx` — same logic.
 */
export function RoutineTriggerCard({
  trigger,
  onSave,
  onRotate,
  onDelete,
  disabled,
}: {
  trigger: RoutineTrigger;
  onSave: (id: string, patch: Record<string, unknown>) => void;
  onRotate: (id: string) => void;
  onDelete: (id: string) => void;
  disabled?: boolean;
}) {
  useTranslation("task-components");
  const [draft, setDraft] = useState({
    label: trigger.label ?? "",
    cronExpression: trigger.cronExpression ?? "",
    signingMode: trigger.signingMode ?? "bearer",
    replayWindowSec: String(trigger.replayWindowSec ?? 300),
  });

  useEffect(() => {
    setDraft({
      label: trigger.label ?? "",
      cronExpression: trigger.cronExpression ?? "",
      signingMode: trigger.signingMode ?? "bearer",
      replayWindowSec: String(trigger.replayWindowSec ?? 300),
    });
  }, [trigger]);

  const KindIcon =
    trigger.kind === "schedule" ? Clock3 : trigger.kind === "webhook" ? Webhook : Zap;
  const humanCron = trigger.kind === "schedule" ? describeCron(draft.cronExpression) : null;
  const lastResultFailed = /fail|error/i.test(trigger.lastResult ?? "");
  const lastResultLabel = trigger.lastResult?.startsWith("Created execution issue ")
    ? t("final-components-a:taskCreated_a3e3e968")
    : trigger.lastResult;

  return (
    <form
      aria-label={t("task-components:trigger_d5cb6b15", { value1: trigger.label ?? trigger.kind })}
      className="space-y-4 rounded-lg border border-border p-4"
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <KindIcon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{trigger.label ?? trigger.kind}</span>
          </div>
          {humanCron ? (
            <p id={`cron-readable-${trigger.id}`} className="text-xs text-muted-foreground">
              {humanCron}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {trigger.lastResult ? (
            <Badge variant={lastResultFailed ? "destructive" : "secondary"}>
              {lastResultLabel}
            </Badge>
          ) : null}
          <span className="text-xs text-muted-foreground">
            {trigger.kind === "schedule" && trigger.nextRunAt
              ? t("task-components:next_12d7c17a", { value1: new Date(trigger.nextRunAt).toLocaleString() })
              : trigger.kind === "webhook"
                ? t("final-components-a:webhook_4814f62c")
                : "API"}
          </span>
        </div>
      </div>

      {trigger.kind === "webhook" && trigger.webhookUrl && (
        <div className="space-y-1.5">
          <Label htmlFor={`webhook-url-${trigger.id}`} className="text-xs">{t("final-components-a:webhookURL_84805a75")}</Label>
          <Input id={`webhook-url-${trigger.id}`} value={trigger.webhookUrl} readOnly onFocus={(event) => event.target.select()} />
          <p className="text-xs text-muted-foreground">{t("task-components:sendAPostRequestWithContentType_d64a0eda")}</p>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">{t("task-components:label_0e66373f")}</Label>
          <Input
            value={draft.label}
            disabled={disabled}
            onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
          />
        </div>
        {trigger.kind === "schedule" && (
          <div className="space-y-1.5 md:col-span-2">
            <Label className="text-xs">{t("task-components:schedule_f4830a1d")}</Label>
            <ScheduleEditor
              value={draft.cronExpression}
              onChange={(cronExpression) =>
                setDraft((current) => ({ ...current, cronExpression }))
              }
            />
          </div>
        )}
        {trigger.kind === "webhook" && (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("task-components:signingMode_0ba52a43")}</Label>
              <Select
                value={draft.signingMode}
                onValueChange={(signingMode) =>
                  setDraft((current) => ({ ...current, signingMode }))
                }
                disabled={disabled}
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
            </div>
            {!SIGNING_MODES_WITHOUT_REPLAY_WINDOW.has(draft.signingMode) && (
              <div className="space-y-1.5">
                <Label className="text-xs">{t("task-components:replayWindowSeconds_88c7ec0c")}</Label>
                <Input
                  value={draft.replayWindowSec}
                  disabled={disabled}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, replayWindowSec: event.target.value }))
                  }
                />
              </div>
            )}
          </>
        )}
      </div>

      {!disabled && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="mr-auto text-muted-foreground hover:text-destructive"
            onClick={() => onDelete(trigger.id)}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />{t("task-components:delete_e2d0a549")}</Button>
          {trigger.kind === "webhook" && (
            <Button variant="outline" size="sm" onClick={() => onRotate(trigger.id)}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />{t("task-components:rotateSecret_4405518d")}</Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              onSave(trigger.id, buildRoutineTriggerPatch(trigger, draft, getLocalTimezone()))
            }
          >
            <Save className="mr-1.5 h-3.5 w-3.5" />{t("task-components:saveTrigger_7ad121c9")}</Button>
        </div>
      )}
    </form>
  );
}
