import { t, useTranslation } from "@/i18n";
import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Plus, Webhook } from "lucide-react";
import type { RoutineTrigger } from "@paperclipai/shared";
import { useSearchParams } from "@/lib/router";
import { routinesApi } from "@/api/routines";
import { queryKeys } from "@/lib/queryKeys";
import { describeCron } from "@/lib/cron-readable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScheduleEditor } from "@/components/ScheduleEditor";
import { useRoutineDetail } from "@/components/routine-sections/context";
import { RoutineTriggerCard } from "./TriggerCard";
import {
  RoutineTriggerWizard,
  defaultTriggerDraft,
  webhookAgentInstructions,
  type TriggerDraft,
} from "./TriggerWizard";
import { AgentInstructions, CopyField } from "./WebhookFields";
import { WebhookUrlWarning } from "./WebhookUrlWarning";

function readDraft(key: string): TriggerDraft | null {
  try {
    const draft = JSON.parse(sessionStorage.getItem(key) ?? "null");
    return draft && ["choose", "schedule", "webhook"].includes(draft.kind)
      ? { ...defaultTriggerDraft, ...draft, sender: draft.sender === "github" ? "github" : "custom" }
      : null;
  } catch {
    return null;
  }
}
function saveDraft(key: string, draft: TriggerDraft) {
  // Only setup choices are persisted. The one-time key stays in component memory.
  try {
    sessionStorage.setItem(key, JSON.stringify(draft));
  } catch {
    throw new Error(
      t("sep28Routines.saveDraftError"),
    );
  }
}
function scheduleCron(draft: TriggerDraft) {
  const [hour, minute] = draft.time.split(":").map(Number);
  const day = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ].indexOf(draft.weekday);
  return `${minute} ${hour} * * ${draft.frequency === "daily" ? "*" : draft.frequency === "weekly" ? day : "1-5"}`;
}

export function RoutineTriggers() {
  useTranslation();
  const ctx = useRoutineDetail();
  const [params, setParams] = useSearchParams();
  const setupId = params.get("triggerSetup");
  const client = useQueryClient();
  const { data, error: statusError } = useQuery({
    queryKey: queryKeys.routines.detail(ctx.routineId),
    queryFn: () => routinesApi.get(ctx.routineId),
    refetchInterval: 3000,
  });
  const routine = data ?? ctx.routine;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [removed, setRemoved] = useState<RoutineTrigger[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    await client.invalidateQueries({ queryKey: ["routines"] });
  }, [client]);
  const change = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("sep28Routines.saveTriggerError"),
      );
    } finally {
      setBusy(false);
    }
  };
  const startSetup = (id: string) => setParams({ triggerSetup: id });
  const closeSetup = useCallback(() => setParams({}), [setParams]);
  if (setupId) {
    const trigger = routine.triggers.find((item) => item.id === setupId);
    if (setupId !== "new" && !trigger)
      return (
        <p role="alert">
          {t("sep28Routines.triggerUnavailable")}{" "}
          <Button variant="link" onClick={closeSetup}>{t("sep28Routines.backToTriggers")}</Button>
        </p>
      );
    if (trigger && !trigger.setupPending)
      return (
        <p>
          {t("sep28Routines.triggerReady")}{" "}
          <Button variant="link" onClick={closeSetup}>{t("sep28Routines.backToTriggers")}</Button>
        </p>
      );
    return (
      <div className="space-y-4">
        {statusError && (
          <p role="alert" className="text-sm text-destructive">{t("sep28Routines.connectionUnavailable")}</p>
        )}
        <TriggerSetup
          key={routine.id}
          routineId={routine.id}
          companyId={routine.companyId}
          routineTitle={routine.title}
          trigger={trigger}
          onExit={closeSetup}
          onRefresh={refresh}
        />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t("sep28Routines.triggerCount", { count: routine.triggers.length })}
        </p>
        <Button size="sm" onClick={() => startSetup("new")}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />{t("sep28Routines.addTrigger")}</Button>
      </div>
      {(error || statusError) && (
        <p role="alert" className="text-sm text-destructive">
          {error || t("sep28Routines.connectionUnavailable")}
        </p>
      )}
      {removed.map((trigger) => (
        <div
          key={trigger.id}
          role="status"
          className="flex items-center gap-3 rounded-md bg-muted/40 px-4 py-3 text-sm"
        >
          <span className="flex-1">
            {t(trigger.kind === "schedule" ? "sep28Routines.removedSchedule" : trigger.kind === "api" ? "sep28Routines.removedApi" : "sep28Routines.removedWebhook")}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              void change(async () => {
                await routinesApi.updateTrigger(trigger.id, {
                  archived: false,
                });
                setRemoved((items) =>
                  items.filter((item) => item.id !== trigger.id),
                );
              })
            }
          >{t("sep28Routines.undo")}</Button>
        </div>
      ))}
      {ctx.secretMessage && (
        <div className="space-y-3 rounded-md border p-4">
          <p className="text-sm font-medium">{ctx.secretMessage.titleKey ? t(ctx.secretMessage.titleKey, { count: ctx.secretMessage.titleCount }) : ctx.secretMessage.title}</p>
          {ctx.secretMessage.entries.map((entry) => (
            <div key={entry.webhookUrl} className="space-y-3">
              <CopyField label={t("sep28Routines.webhookUrl")} value={entry.webhookUrl} />
              <CopyField label={t("sep28Routines.secretKey")} value={entry.webhookSecret} />
            </div>
          ))}
          <Button variant="outline" onClick={() => ctx.setSecretMessage(null)}>{t("sep28Routines.done")}</Button>
        </div>
      )}
      {routine.triggers.length === 0 && (
        <p className="py-6 text-sm text-muted-foreground">{t("sep28Routines.noTriggersHelp")}</p>
      )}
      <fieldset disabled={busy} className="min-w-0 space-y-3">
        {routine.triggers.map((trigger) => (
          <RoutineTriggerCard
            key={trigger.id}
            kind={
              trigger.kind === "schedule"
                ? "schedule"
                : trigger.kind === "api"
                  ? "api"
                  : "webhook"
            }
            icon={
              trigger.kind === "schedule" ? (
                <CalendarClock className="h-4 w-4" />
              ) : (
                <Webhook className="h-4 w-4" />
              )
            }
            title={
              trigger.kind === "schedule"
                ? (describeCron(trigger.cronExpression) ?? t("sep28Routines.schedule"))
                : trigger.kind === "api"
                  ? t("sep28Routines.apiTrigger")
                  : trigger.signingMode === "github_hmac"
                    ? t("sep28Routines.githubWebhook")
                    : t("sep28Routines.webhook")
            }
            summary={
              trigger.setupPending
                ? t("sep28Routines.setupUnfinished")
                : !trigger.enabled
                  ? t("sep28Routines.paused")
                  : trigger.kind === "schedule"
                    ? (trigger.timezone ?? "UTC")
                    : trigger.kind === "api"
                      ? t("sep28Routines.runThroughApi")
                      : trigger.lastWebhookDelivery?.status === "rejected"
                        ? t("sep28Routines.authenticationFailed")
                        : trigger.lastWebhookDelivery?.status === "received" &&
                            !trigger.lastWebhookDelivery.test
                          ? t("sep28Routines.receivingEvents")
                          : t("sep28Routines.readyWaiting")
            }
            expanded={expanded === trigger.id}
            editLabel={trigger.setupPending ? t("sep28Routines.resumeSetup") : undefined}
            onEdit={() =>
              trigger.setupPending
                ? startSetup(trigger.id)
                : setExpanded((id) => (id === trigger.id ? null : trigger.id))
            }
            onRemove={() =>
              void change(async () => {
                await routinesApi.updateTrigger(trigger.id, { archived: true });
                setRemoved((items) => [...items, trigger]);
              })
            }
          >
            {trigger.setupPending ? (
              <Button onClick={() => startSetup(trigger.id)}>{t("sep28Routines.resumeSetup")}</Button>
            ) : trigger.kind === "schedule" ? (
              <ScheduleSettings
                trigger={trigger}
                onSave={async (patch) => {
                  await routinesApi.updateTrigger(trigger.id, patch);
                  await refresh();
                  setExpanded(null);
                }}
                onCancel={() => setExpanded(null)}
              />
            ) : trigger.kind === "api" ? (
              <p className="text-sm text-muted-foreground">{t("sep28Routines.apiTriggerHelp")}</p>
            ) : (
              <WebhookSettings
                trigger={trigger}
                routineTitle={routine.title}
                onRefresh={refresh}
              />
            )}
            {!trigger.setupPending && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void change(async () => {
                    await routinesApi.updateTrigger(trigger.id, {
                      enabled: !trigger.enabled,
                    });
                  })
                }
              >
                {trigger.enabled ? t("sep28Routines.pauseTrigger") : t("sep28Routines.enableTrigger")}
              </Button>
            )}
          </RoutineTriggerCard>
        ))}
      </fieldset>
    </div>
  );
}

function TriggerSetup({
  routineId,
  companyId,
  routineTitle,
  trigger,
  onExit,
  onRefresh,
}: {
  routineId: string;
  companyId: string;
  routineTitle: string;
  trigger?: RoutineTrigger;
  onExit: () => void;
  onRefresh: () => Promise<void>;
}) {
  useTranslation();
  const [, setParams] = useSearchParams();
  const storagePrefix = `routine-trigger-draft:${companyId}:${routineId}:`;
  const createdRef = useRef<RoutineTrigger | undefined>(trigger);
  const [created, setCreated] = useState(trigger);
  const [secret, setSecret] = useState("");
  const currentTrigger = trigger ?? created;
  const [initialDraft] = useState<TriggerDraft>(() => {
    const saved = readDraft(storagePrefix + (trigger?.id ?? "new"));
    if (trigger)
      return {
        ...defaultTriggerDraft,
        ...saved,
        kind: "webhook",
        sender: trigger.signingMode === "github_hmac" ? "github" : "custom",
        signingMode: trigger.signingMode === "bearer" ? "bearer" : trigger.signingMode === "fireflies_hmac" ? "fireflies_hmac" : "app_webhook",
        created: true,
        step: saved?.step ?? 1,
        availableStep: Math.max(1, saved?.availableStep ?? 1),
      };
    return (
      saved ?? {
        ...defaultTriggerDraft,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        created: false,
      }
    );
  });
  const createWebhook = useCallback(
    async (draft: TriggerDraft) => {
      if (createdRef.current) return;
      const response = await routinesApi.createTrigger(routineId, {
        kind: "webhook",
        signingMode: draft.sender === "github" ? "github_hmac" : "app_webhook",
        setupPending: true,
      });
      createdRef.current = response.trigger;
      setCreated({
        ...response.trigger,
        webhookUrl:
          response.secretMaterial?.webhookUrl ?? response.trigger.webhookUrl,
      });
      setSecret(response.secretMaterial?.webhookSecret ?? "");
      saveDraft(storagePrefix + response.trigger.id, {
        ...draft,
        created: true,
        step: 1,
        availableStep: 1,
      });
      sessionStorage.removeItem(storagePrefix + "new");
      await onRefresh();
      setParams({ triggerSetup: response.trigger.id }, { replace: true });
    },
    [routineId, onRefresh, storagePrefix, setParams],
  );
  const saveExit = useCallback(
    (draft: TriggerDraft) => {
      saveDraft(storagePrefix + (createdRef.current?.id ?? "new"), draft);
      onExit();
    },
    [onExit, storagePrefix],
  );
  const finish = useCallback(
    async (draft: TriggerDraft) => {
      if (draft.kind === "schedule")
        await routinesApi.createTrigger(routineId, {
          kind: "schedule",
          cronExpression: scheduleCron(draft),
          timezone: draft.timezone,
        });
      else {
        if (!createdRef.current)
          throw new Error(t("sep28Routines.createBeforeFinish"));
        await routinesApi.updateTrigger(createdRef.current.id, {
          setupPending: false,
        });
      }
      try {
        sessionStorage.removeItem(
          storagePrefix + (createdRef.current?.id ?? "new"),
        );
      } catch {
        // The server mutation succeeded; draft cleanup must not cause a retry.
      }
      await onRefresh();
      onExit();
    },
    [routineId, onRefresh, onExit, storagePrefix],
  );
  const { routine: currentRoutine } = useRoutineDetail();
  return (
    <RoutineTriggerWizard
      initialDraft={initialDraft}
      routineTitle={routineTitle}
      routineId={routineId}
      routineActive={currentRoutine.status === "active"}
      webhookUrl={currentTrigger?.webhookUrl ?? ""}
      webhookSecret={secret}
      onCreateWebhook={createWebhook}
      onSaveExit={saveExit}
      onFinish={finish}
      onRotateKey={async () => {
        if (!createdRef.current) return;
        const response = await routinesApi.rotateTriggerSecret(
          createdRef.current.id,
        );
        setSecret(response.secretMaterial.webhookSecret);
        await onRefresh();
      }}
      checkResult={currentTrigger?.lastWebhookDelivery?.status ?? "waiting"}
    />
  );
}

function ScheduleSettings({
  trigger,
  onSave,
  onCancel,
}: {
  trigger: RoutineTrigger;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  useTranslation();
  const [cronExpression, setCron] = useState(
    trigger.cronExpression ?? "0 9 * * *",
  );
  const [timezone, setTimezone] = useState(trigger.timezone ?? "UTC");
  const [valid, setValid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <fieldset disabled={busy} className="min-w-0 space-y-4">
      <ScheduleEditor
        value={cronExpression}
        onChange={setCron}
        onValidityChange={setValid}
      />
      <Label>{t("sep28Routines.timeZone")}<Input
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
        />
      </Label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          disabled={!valid}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await onSave({ cronExpression, timezone });
            } catch (cause) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : t("sep28Routines.saveScheduleError"),
              );
            } finally {
              setBusy(false);
            }
          }}
        >{t("sep28Routines.saveSchedule")}</Button>
        <Button variant="outline" onClick={onCancel}>{t("sep28Routines.cancel")}</Button>
      </div>
    </fieldset>
  );
}

function WebhookSettings({
  trigger,
  routineTitle,
  onRefresh,
}: {
  trigger: RoutineTrigger;
  routineTitle: string;
  onRefresh: () => Promise<void>;
}) {
  useTranslation();
  const [secret, setSecret] = useState("");
  const [replace, setReplace] = useState(false);
  const [checkBaseline, setCheckBaseline] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const github = trigger.signingMode === "github_hmac";
  const delivery = trigger.lastWebhookDelivery;
  const checked =
    checkBaseline !== null && delivery && delivery.receivedAt !== checkBaseline;
  return (
    <div className="space-y-4">
      <WebhookUrlWarning url={trigger.webhookUrl ?? ""} />
      {secret && (github || trigger.signingMode === "bearer" || trigger.signingMode === "app_webhook" || trigger.signingMode === "fireflies_hmac") && (
        <AgentInstructions
          value={webhookAgentInstructions(
            github ? "github" : "custom",
            routineTitle,
            trigger.webhookUrl ?? "",
            secret,
            false,
            trigger.signingMode === "bearer" ? "bearer" : trigger.signingMode === "fireflies_hmac" ? "fireflies_hmac" : "app_webhook",
          )}
        />
      )}
      <CopyField label={t("sep28Routines.webhookUrl")} value={trigger.webhookUrl ?? ""} />
      {trigger.signingMode !== "none" && (
        <div className="space-y-2">
          {secret ? (
            <CopyField
              label={
                trigger.signingMode === "bearer"
                  ? t("sep28Routines.authorizationValue")
                  : t("sep28Routines.secretKey")
              }
              value={
                trigger.signingMode === "bearer" ? `Bearer ${secret}` : secret
              }
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t("sep28Routines.keyHidden")}</p>
          )}
          <Button variant="outline" size="sm" onClick={() => setReplace(true)}>{t("sep28Routines.replaceKey")}</Button>
          {secret && (
            <Button variant="ghost" size="sm" onClick={() => setSecret("")}>{t("sep28Routines.hideKey")}</Button>
          )}
        </div>
      )}
      {trigger.signingMode === "none" && (
        <p className="text-sm text-muted-foreground">{t("sep28Routines.urlSharedSecret")}</p>
      )}
      {trigger.signingMode === "hmac_sha256" && (
        <p className="text-sm text-muted-foreground">{t("sep28Routines.hmacHelp")}</p>
      )}
      <Button
        variant="outline"
        onClick={() =>
          setCheckBaseline(trigger.lastWebhookDelivery?.receivedAt ?? "")
        }
      >{t("sep28Routines.checkConnection")}</Button>
      <Dialog open={replace} onOpenChange={setReplace}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("sep28Routines.replaceKeyTitle")}</DialogTitle>
            <DialogDescription>{t("sep28Routines.replaceKeyWarning")}</DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const response = await routinesApi.rotateTriggerSecret(
                  trigger.id,
                );
                setSecret(response.secretMaterial.webhookSecret);
                setReplace(false);
                await onRefresh();
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : t("sep28Routines.replaceKeyError"),
                );
              } finally {
                setBusy(false);
              }
            }}
          >{t("sep28Routines.replaceKey")}</Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={checkBaseline !== null}
        onOpenChange={(open) => {
          if (!open) setCheckBaseline(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("sep28Routines.checkConnection")}</DialogTitle>
            <DialogDescription>{t("sep28Routines.enabledCheckWarning")}</DialogDescription>
          </DialogHeader>
          <p role="status" className="text-sm">
            {checked
              ? delivery.status === "received"
                ? t("sep28Routines.eventReceived")
                : t("sep28Routines.eventAuthFailed")
              : t("sep28Routines.waitingEvent")}
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
