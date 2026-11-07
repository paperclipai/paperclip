import { localizeUiError, describeUiError } from "@/lib/localized-ui-error";
import { t, useTranslation, Trans } from "@/i18n";
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
    throw localizeUiError(new Error(
      "Couldn’t save your draft in this browser. Keep this page open and try again.",
    ), { key: "final-components-b:error.Couldn_t_save_your_draft_in_this_browser_Keep_this_page_open_and_try_a_f2b246" });
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
  useTranslation("task-components");
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
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    await client.invalidateQueries({ queryKey: ["routines"] });
  }, [client]);
  const change = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause
          : localizeUiError(new Error("Couldn’t save the trigger. Please try again."), { key: "final-components-b:error.Couldn_t_save_the_trigger_Please_try_again_bbc046" }),
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
        <p role="alert">{t("task-components:thisTriggerIsNoLongerAvailable_33f2030f")}{" "}
          <Button variant="link" onClick={closeSetup}>{t("task-components:backToTriggers_4b2775d3")}</Button>
        </p>
      );
    if (trigger && !trigger.setupPending)
      return (
        <p>{t("task-components:thisTriggerIsReady_dd9d1377")}{" "}
          <Button variant="link" onClick={closeSetup}>{t("task-components:backToTriggers_4b2775d3")}</Button>
        </p>
      );
    return (
      <div className="space-y-4">
        {statusError && (
          <p role="alert" className="text-sm text-destructive">{t("task-components:connectionStatusIsUnavailableRetrying_861491d0")}</p>
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
          {routine.triggers.length}{" "}
          {routine.triggers.length === 1 ? t("task-components:trigger_683259fe") : t("task-components:triggers_51936fd3")}
        </p>
        <Button size="sm" onClick={() => startSetup("new")}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />{t("task-components:addTrigger_58fd3089")}</Button>
      </div>
      {(error || statusError) && (
        <p role="alert" className="text-sm text-destructive">
          {error ? describeUiError(error).body : t("task-components:connectionStatusIsUnavailableRetrying_861491d0")}
        </p>
      )}
      {removed.map((trigger) => (
        <div
          key={trigger.id}
          role="status"
          className="flex items-center gap-3 rounded-md bg-muted/40 px-4 py-3 text-sm"
        >
          <span className="flex-1"><Trans ns="task-components" i18nKey="sentence_f55113678e55" components={{ part1: <>{trigger.kind === "schedule"
              ? t("task-components:schedule_f4830a1d")
              : trigger.kind === "api"
                ? t("task-components:apiTrigger_ef556ef2")
                : t("final-components-b:routine-triggers.RoutineTriggers.Webhook_4814f6")}</> }} /></span>
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
          >{t("task-components:undo_a8283ade")}</Button>
        </div>
      ))}
      {ctx.secretMessage && (
        <div className="space-y-3 rounded-md border p-4">
          <p className="text-sm font-medium">{ctx.secretMessage.title}</p>
          {ctx.secretMessage.entries.map((entry) => (
            <div key={entry.webhookUrl} className="space-y-3">
              <CopyField label={t("final-components-b:routine-triggers.RoutineTriggers.Webhook_URL_84805a")} value={entry.webhookUrl} />
              <CopyField label={t("task-components:secretKey_f47a99eb")} value={entry.webhookSecret} />
            </div>
          ))}
          <Button variant="outline" onClick={() => ctx.setSecretMessage(null)}>{t("task-components:done_11a6767d")}</Button>
        </div>
      )}
      {routine.triggers.length === 0 && (
        <p className="py-6 text-sm text-muted-foreground">{t("task-components:runThisRoutineOnAScheduleOr_98d55cd1")}</p>
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
                ? (describeCron(trigger.cronExpression) ?? t("task-components:schedule_f4830a1d"))
                : trigger.kind === "api"
                  ? t("task-components:apiTrigger_ef556ef2")
                  : trigger.signingMode === "github_hmac"
                    ? t("final-components-b:routine-triggers.RoutineTriggers.GitHub_webhook_62487a")
                    : t("final-components-b:routine-triggers.RoutineTriggers.Webhook_4814f6")
            }
            summary={
              trigger.setupPending
                ? t("final-components-b:routine-triggers.RoutineTriggers.Setup_unfinished_Events_only_test_the_connection_29f7e4")
                : !trigger.enabled
                  ? t("final-components-b:routine-triggers.RoutineTriggers.Paused_e159b0")
                  : trigger.kind === "schedule"
                    ? (trigger.timezone ?? "UTC")
                    : trigger.kind === "api"
                      ? t("final-components-b:routine-triggers.RoutineTriggers.Run_through_the_API_7f4f8a")
                      : trigger.lastWebhookDelivery?.status === "rejected"
                        ? t("final-components-b:routine-triggers.RoutineTriggers.Authentication_failed_Check_the_key_in_your_app_1d0c75")
                        : trigger.lastWebhookDelivery?.status === "received" &&
                            !trigger.lastWebhookDelivery.test
                          ? t("final-components-b:routine-triggers.RoutineTriggers.Receiving_events_3ce60a")
                          : t("final-components-b:routine-triggers.RoutineTriggers.Ready_Waiting_for_an_event_0e26ab")
            }
            expanded={expanded === trigger.id}
            editLabel={trigger.setupPending ? t("final-components-b:routine-triggers.RoutineTriggers.Resume_setup_014c5f") : undefined}
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
              <Button onClick={() => startSetup(trigger.id)}>{t("task-components:resumeSetup_014c5f81")}</Button>
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
              <p className="text-sm text-muted-foreground">{t("task-components:thisTriggerStartsTheRoutineThroughThe_76104f99")}</p>
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
                {trigger.enabled ? t("task-components:pauseTrigger_6b084b69") : t("task-components:enableTrigger_1e3e32db")}
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
  useTranslation("task-components");
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
          throw localizeUiError(new Error("Create the webhook before finishing setup."), { key: "final-components-b:error.Create_the_webhook_before_finishing_setup_e37c31" });
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
  useTranslation("task-components");
  const [cronExpression, setCron] = useState(
    trigger.cronExpression ?? "0 9 * * *",
  );
  const [timezone, setTimezone] = useState(trigger.timezone ?? "UTC");
  const [valid, setValid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  return (
    <fieldset disabled={busy} className="min-w-0 space-y-4">
      <ScheduleEditor
        value={cronExpression}
        onChange={setCron}
        onValidityChange={setValid}
      />
      <Label>{t("task-components:timeZone_b9fe1464")}<Input
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
        />
      </Label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {describeUiError(error).body}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          disabled={!valid}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onSave({ cronExpression, timezone });
            } catch (cause) {
              setError(
                cause instanceof Error
                  ? cause
                  : localizeUiError(new Error("Couldn’t save schedule."), { key: "final-components-b:error.Couldn_t_save_schedule_126c6d" }),
              );
            } finally {
              setBusy(false);
            }
          }}
        >{t("task-components:saveSchedule_387f355f")}</Button>
        <Button variant="outline" onClick={onCancel}>{t("task-components:cancel_19766ed6")}</Button>
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
  useTranslation("task-components");
  const [secret, setSecret] = useState("");
  const [replace, setReplace] = useState(false);
  const [checkBaseline, setCheckBaseline] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
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
      <CopyField label={t("final-components-b:routine-triggers.RoutineTriggers.Webhook_URL_84805a")} value={trigger.webhookUrl ?? ""} />
      {trigger.signingMode !== "none" && (
        <div className="space-y-2">
          {secret ? (
            <CopyField
              label={
                trigger.signingMode === "bearer"
                  ? t("task-components:authorizationHeaderValue_39a91b3d")
                  : t("task-components:secretKey_f47a99eb")
              }
              value={
                trigger.signingMode === "bearer" ? `Bearer ${secret}` : secret
              }
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t("task-components:theSecretKeyIsHidden_e27dfe1b")}</p>
          )}
          <Button variant="outline" size="sm" onClick={() => setReplace(true)}>{t("task-components:replaceKey_548dca59")}</Button>
          {secret && (
            <Button variant="ghost" size="sm" onClick={() => setSecret("")}>{t("task-components:hideKey_0614b215")}</Button>
          )}
        </div>
      )}
      {trigger.signingMode === "none" && (
        <p className="text-sm text-muted-foreground">{t("task-components:thisWebhookUsesItsUrlAsThe_43ad86bc")}</p>
      )}
      {trigger.signingMode === "hmac_sha256" && (
        <p className="text-sm text-muted-foreground">{t("task-components:signTheTimestampAPeriodAndThe_e88a8ed8")}</p>
      )}
      <Button
        variant="outline"
        onClick={() =>
          setCheckBaseline(trigger.lastWebhookDelivery?.receivedAt ?? "")
        }
      >{t("task-components:checkConnection_be5dff52")}</Button>
      <Dialog open={replace} onOpenChange={setReplace}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("task-components:replaceTheWebhookKey_76f7b007")}</DialogTitle>
            <DialogDescription>{t("task-components:theOldKeyWillStopWorkingUpdate_43f717b1")}</DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {describeUiError(error).body}
            </p>
          )}
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
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
                    ? cause
                    : localizeUiError(new Error("Couldn’t replace the key."), { key: "final-components-b:error.Couldn_t_replace_the_key_e315ff" }),
                );
              } finally {
                setBusy(false);
              }
            }}
          >{t("task-components:replaceKey_548dca59")}</Button>
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
            <DialogTitle>{t("task-components:checkConnection_be5dff52")}</DialogTitle>
            <DialogDescription>{t("task-components:thisWebhookIsAlreadyEnabledEventsSent_62600030")}</DialogDescription>
          </DialogHeader>
          <p role="status" className="text-sm">
            {checked
              ? delivery.status === "received"
                ? t("task-components:eventReceivedAuthenticationPassed_809603f5")
                : t("task-components:eventArrivedButAuthenticationFailedCheckThe_c8fb89d2")
              : t("task-components:waitingForAnEventFromYourApp_6da2e8bc")}
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
