import { useCallback, useEffect, useState } from "react";
import {
  CalendarClock,
  Check,
  CheckCircle2,
  AlertCircle,
  Globe,
  GitBranch,
  Radio,
  Webhook,
} from "lucide-react";
import {
  SetupWizardNavigation,
  SetupWizardFooter,
} from "@/components/SetupWizard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { t, useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import { AgentInstructions, CopyField } from "./WebhookFields";
import { WebhookUrlWarning } from "./WebhookUrlWarning";

export type TriggerDraft = {
  kind: "choose" | "schedule" | "webhook";
  step: number;
  availableStep: number;
  sender: "custom" | "github";
  /** Retained when resuming webhooks created before generic signed-app support. */
  signingMode?: "bearer" | "app_webhook" | "fireflies_hmac";
  frequency: string;
  time: string;
  weekday: string;
  timezone: string;
  created: boolean;
};
export const defaultTriggerDraft: TriggerDraft = {
  kind: "choose",
  step: 0,
  availableStep: 0,
  sender: "custom",
  frequency: "weekdays",
  time: "09:00",
  weekday: "Monday",
  timezone: "America/Chicago",
  created: false,
};
export function webhookAgentInstructions(
  sender: TriggerDraft["sender"],
  routineTitle: string,
  webhookUrl: string,
  webhookSecret: string,
  setupPending = true,
  signingMode: TriggerDraft["signingMode"] = "app_webhook",
) {
  const signatureHeaders = signingMode === "fireflies_hmac"
    ? "X-Hub-Signature"
    : t("routines.webhookAgentInstructions.signatureHeadersBoth");
  const common = [
    t("routines.webhookAgentInstructions.connectApp", { routine: JSON.stringify(routineTitle) }),
    t("routines.webhookAgentInstructions.webhookUrl", { url: webhookUrl }),
    t("routines.webhookAgentInstructions.postJson"),
    "Content-Type: application/json",
  ];
  const auth =
    sender === "github"
      ? [
          t("routines.webhookAgentInstructions.githubOpenSettings"),
          t("routines.webhookAgentInstructions.githubPayloadUrl"),
          t("routines.webhookAgentInstructions.githubSecret", { secret: webhookSecret }),
          t("routines.webhookAgentInstructions.githubSecretField"),
          t("routines.webhookAgentInstructions.githubEvents"),
          t("routines.webhookAgentInstructions.githubCheck"),
        ]
      : [
          t("routines.webhookAgentInstructions.secretKey", { secret: webhookSecret }),
          ...(signingMode === "bearer" ? [] : [
            t("routines.webhookAgentInstructions.signingHmac", { headers: signatureHeaders }),
          ]),
          ...(signingMode === "fireflies_hmac" ? [] : [
            t("routines.webhookAgentInstructions.bearerHeader", { secret: webhookSecret }),
          ]),
          t("routines.webhookAgentInstructions.subscribeEvents"),
          t("routines.webhookAgentInstructions.addWebhook"),
          t("routines.webhookAgentInstructions.idempotency"),
          t("routines.webhookAgentInstructions.exampleBody", { example: '{"event":"deployment.completed","environment":"production"}' }),
          t("routines.webhookAgentInstructions.sendTestEvent"),
        ];
  return [
    ...common,
    ...auth,
    t("routines.webhookAgentInstructions.checkInPaperclip"),
    ...(setupPending
      ? [
          t("routines.webhookAgentInstructions.duringSetup"),
          t("routines.webhookAgentInstructions.finishSetup"),
        ]
      : [
          t("routines.webhookAgentInstructions.enabled"),
        ]),
    t("routines.webhookAgentInstructions.storeKey"),
  ].join("\n");
}
function getWeekdayLabel(day: string) {
  const labels: Record<string, string> = {
    Monday: t("routines.getWeekdayLabel.monday"),
    Tuesday: t("routines.getWeekdayLabel.tuesday"),
    Wednesday: t("routines.getWeekdayLabel.wednesday"),
    Thursday: t("routines.getWeekdayLabel.thursday"),
    Friday: t("routines.getWeekdayLabel.friday"),
    Saturday: t("routines.getWeekdayLabel.saturday"),
    Sunday: t("routines.getWeekdayLabel.sunday"),
  };
  return labels[day] ?? day;
}
export function describeSchedule(draft: TriggerDraft) {
  if (draft.frequency === "daily") return t("routines.describeSchedule.daily", { time: draft.time });
  if (draft.frequency === "weekly") {
    return t("routines.describeSchedule.weekly", { day: getWeekdayLabel(draft.weekday), time: draft.time });
  }
  return t("routines.describeSchedule.weekdays", { time: draft.time });
}
export function RoutineTriggerWizard({
  initialDraft,
  onSaveExit,
  onFinish,
  onCreateWebhook,
  onRotateKey,
  routineTitle,
  routineId,
  routineActive = true,
  webhookUrl = "",
  webhookSecret = "",
  checkResult = "waiting",
}: {
  initialDraft: TriggerDraft;
  routineTitle: string;
  routineId: string;
  routineActive?: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  onCreateWebhook?: (draft: TriggerDraft) => Promise<void>;
  onRotateKey?: () => Promise<void>;
  onSaveExit: (draft: TriggerDraft) => void | Promise<void>;
  onFinish: (draft: TriggerDraft) => void | Promise<void>;
  checkResult?: "waiting" | "received" | "rejected" | "no_event";
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(initialDraft);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const { setBreadcrumbs } = useBreadcrumbs();
  const perform = useCallback(
    async (action: () => void | Promise<void>) => {
      if (busy) return;
      setBusy(true);
      setSaveError("");
      try {
        await action();
      } catch (error) {
        setSaveError(
          error instanceof Error
            ? error.message
            : t("routines.RoutineTriggerWizard.saveError"),
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, t],
  );
  const saveAndExit = useCallback(() => {
    void perform(() => onSaveExit(draft));
  }, [draft, onSaveExit, perform]);
  useEffect(() => {
    setBreadcrumbs([
      {
        label: routineTitle,
        href: `/routines/${routineId}/triggers`,
        onClick: (event) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          saveAndExit();
        },
      },
      { label: t("routines.RoutineTriggerWizard.addTrigger") },
    ]);
  }, [saveAndExit, setBreadcrumbs, routineTitle, routineId, t]);
  const schedule = draft.kind === "schedule";
  const github = draft.sender === "github";
  const labels = schedule
    ? [
        t("routines.RoutineTriggerWizard.chooseTrigger"),
        t("routines.RoutineTriggerWizard.setSchedule"),
        t("routines.RoutineTriggerWizard.reviewSchedule"),
      ]
    : [
        t("routines.RoutineTriggerWizard.chooseTrigger"),
        t("routines.RoutineTriggerWizard.connectYourApp"),
        t("routines.RoutineTriggerWizard.checkConnection"),
      ];
  const sourceName = github ? "GitHub" : t("routines.RoutineTriggerWizard.yourApp");
  function patch(values: Partial<TriggerDraft>) {
    setDraft((current) => ({ ...current, ...values }));
  }
  function advance() {
    void perform(async () => {
      if (draft.kind === "webhook" && draft.step === 0 && !draft.created)
        await onCreateWebhook?.(draft);
      const step = draft.step + 1;
      patch({
        step,
        availableStep: Math.max(draft.availableStep, step),
        created:
          draft.created || (draft.kind === "webhook" && draft.step === 0),
      });
    });
  }
  const title =
    draft.step === 0
      ? t("routines.RoutineTriggerWizard.titleWhen")
      : schedule
        ? draft.step === 1
          ? t("routines.RoutineTriggerWizard.titleSetSchedule")
          : t("routines.RoutineTriggerWizard.titleReviewSchedule")
        : draft.step === 1
          ? t("routines.RoutineTriggerWizard.titleConnect", { source: sourceName })
          : t("routines.RoutineTriggerWizard.titleCheck");
  const subtitle =
    draft.step === 0
      ? t("routines.RoutineTriggerWizard.subtitleStart", { routine: routineTitle })
      : schedule
        ? draft.step === 1
          ? t("routines.RoutineTriggerWizard.subtitleSchedule")
          : t("routines.RoutineTriggerWizard.subtitleScheduleReview")
        : draft.step === 1
          ? t("routines.RoutineTriggerWizard.subtitleConnect")
          : t("routines.RoutineTriggerWizard.subtitleCheck");
  const selectClass =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  const goBack = (
    <Button variant="outline" onClick={() => patch({ step: draft.step - 1 })}>
      {t("routines.RoutineTriggerWizard.back")}
    </Button>
  );
  return (
    <div className="min-w-0 w-full max-w-2xl space-y-6">
      <SetupWizardNavigation
        takeover
        disabled={busy}
        ariaLabel={t("routines.RoutineTriggerWizard.progressLabel")}
        labels={labels}
        step={draft.step}
        availableStep={draft.availableStep}
        onSelect={(step) => patch({ step })}
      />
      <fieldset disabled={busy} className="min-w-0 space-y-6">
        <div className="space-y-1">
          <h1 className="text-xl font-bold">{title}</h1>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
        {!schedule && draft.step > 0 && <WebhookUrlWarning url={webhookUrl} />}
        {draft.step === 0 && (
          <fieldset className="space-y-3">
            <legend className="sr-only">{t("routines.RoutineTriggerWizard.triggerTypeLegend")}</legend>
            {(
              [
                {
                  kind: "schedule",
                  label: t("routines.RoutineTriggerWizard.onSchedule"),
                  detail: t("routines.RoutineTriggerWizard.onScheduleDetail"),
                  Icon: CalendarClock,
                },
                {
                  kind: "webhook",
                  label: t("routines.RoutineTriggerWizard.onWebhook"),
                  detail:
                    t("routines.RoutineTriggerWizard.onWebhookDetail"),
                  Icon: Webhook,
                },
              ] as const
            ).map(({ kind, label, detail, Icon }) => (
              <label
                key={kind}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md border p-4 focus-within:ring-2 focus-within:ring-ring",
                  draft.kind === kind
                    ? "border-primary bg-accent/30"
                    : "border-border hover:bg-accent/20",
                )}
              >
                <input
                  type="radio"
                  name="trigger-kind"
                  checked={draft.kind === kind}
                  disabled={draft.created && kind !== draft.kind}
                  onChange={() =>
                    patch({
                      kind,
                      availableStep:
                        kind === draft.kind ? draft.availableStep : 0,
                    })
                  }
                  className="sr-only"
                />
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1">
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {detail}
                  </span>
                </span>
                {draft.kind === kind && <Check className="h-4 w-4" />}
              </label>
            ))}
          </fieldset>
        )}
        {schedule && draft.step === 1 && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="repeat">{t("routines.RoutineTriggerWizard.repeatLabel")}</Label>
                <select
                  id="repeat"
                  className={selectClass}
                  value={draft.frequency}
                  onChange={(event) => patch({ frequency: event.target.value })}
                >
                  <option value="daily">{t("routines.RoutineTriggerWizard.everyDay")}</option>
                  <option value="weekdays">{t("routines.RoutineTriggerWizard.weekdaysOption")}</option>
                  <option value="weekly">{t("routines.RoutineTriggerWizard.everyWeek")}</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="run-time">{t("routines.RoutineTriggerWizard.timeLabel")}</Label>
                <Input
                  id="run-time"
                  type="time"
                  value={draft.time}
                  onChange={(event) => patch({ time: event.target.value })}
                />
              </div>
            </div>
            {draft.frequency === "weekly" && (
              <div className="space-y-2">
                <Label htmlFor="run-day">{t("routines.RoutineTriggerWizard.dayLabel")}</Label>
                <select
                  id="run-day"
                  className={selectClass}
                  value={draft.weekday}
                  onChange={(event) => patch({ weekday: event.target.value })}
                >
                  {[
                    "Monday",
                    "Tuesday",
                    "Wednesday",
                    "Thursday",
                    "Friday",
                    "Saturday",
                    "Sunday",
                  ].map((day) => (
                    <option key={day} value={day}>{getWeekdayLabel(day)}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="timezone">{t("routines.RoutineTriggerWizard.timeZoneLabel")}</Label>
              <select
                id="timezone"
                className={selectClass}
                value={draft.timezone}
                onChange={(event) => patch({ timezone: event.target.value })}
              >
                {Array.from(
                  new Set([
                    draft.timezone,
                    "America/Chicago",
                    "America/New_York",
                    "America/Los_Angeles",
                    "Europe/London",
                    "UTC",
                  ]),
                ).map((zone) => (
                  <option key={zone}>{zone}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {t("routines.RoutineTriggerWizard.timeZoneHelp")}
              </p>
            </div>
          </div>
        )}
        {schedule && draft.step === 2 && (
          <div className="space-y-5">
            <div className="flex items-start gap-3 rounded-md bg-muted/40 p-4">
              <CalendarClock className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">{describeSchedule(draft)}</p>
                <p className="text-xs text-muted-foreground">
                  {draft.timezone}
                </p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("routines.RoutineTriggerWizard.scheduleRunsNote")}
            </p>
          </div>
        )}
        {draft.step === 0 && draft.kind === "webhook" && (
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">
              {t("routines.RoutineTriggerWizard.senderQuestion")}
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  {
                    sender: "custom",
                    label: t("routines.RoutineTriggerWizard.anotherAppOrScript"),
                    Icon: Globe,
                  },
                  { sender: "github", label: "GitHub", Icon: GitBranch },
                ] as const
              ).map(({ sender, label, Icon }) => (
                <label
                  key={sender}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-md border p-3 focus-within:ring-2 focus-within:ring-ring",
                    draft.sender === sender
                      ? "border-primary bg-accent/30"
                      : "border-border",
                    draft.created && "cursor-default",
                  )}
                >
                  <input
                    className="sr-only"
                    type="radio"
                    name="sender"
                    checked={draft.sender === sender}
                    disabled={draft.created}
                    onChange={() => patch({ sender })}
                  />
                  <Icon className="h-4 w-4" />
                  <span className="flex-1 text-sm">{label}</span>
                  {draft.sender === sender && <Check className="h-4 w-4" />}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {draft.kind === "webhook" && draft.step === 0 && (
          <p className="text-sm text-muted-foreground">
            {t("routines.RoutineTriggerWizard.publicServicesHttps")}
          </p>
        )}
        {!schedule && draft.step === 1 && (
          <div className="space-y-5">
            {webhookSecret && (
              <AgentInstructions
                value={webhookAgentInstructions(
                  draft.sender,
                  routineTitle,
                  webhookUrl,
                  webhookSecret,
                  true,
                  draft.signingMode,
                )}
              />
            )}
            <CopyField
              label={github ? t("routines.RoutineTriggerWizard.payloadUrl") : t("routines.RoutineTriggerWizard.webhookUrl")}
              value={webhookUrl}
            />
            {!github && draft.signingMode !== "bearer" && (
              <p className="text-sm text-muted-foreground">
                {t("routines.RoutineTriggerWizard.pasteKey")}
                {draft.signingMode !== "fireflies_hmac" && <>
                  {" "}{t("routines.RoutineTriggerWizard.customHeadersHint")}
                </>}
              </p>
            )}
            {webhookSecret ? (
              <CopyField
                label={github ? t("routines.RoutineTriggerWizard.secretLabel") : draft.signingMode === "bearer" ? t("routines.RoutineTriggerWizard.authHeaderValue") : t("routines.RoutineTriggerWizard.secretKey")}
                value={!github && draft.signingMode === "bearer" ? `Bearer ${webhookSecret}` : webhookSecret}
              />
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  {t("routines.RoutineTriggerWizard.keyHidden")}
                </p>
                <Button
                  variant="outline"
                  onClick={() => void perform(() => onRotateKey?.())}
                >
                  {t("routines.RoutineTriggerWizard.generateKey")}
                </Button>
              </div>
            )}
          </div>
        )}
        {!schedule && draft.step === 2 && (
          <div className="space-y-5">
            <div className="space-y-1 rounded-md border border-border p-4">
              <p className="text-sm font-medium">{t("routines.RoutineTriggerWizard.testOnly")}</p>
              <p className="text-sm text-muted-foreground">
                {t("routines.RoutineTriggerWizard.testOnlyDetail")}
              </p>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">
                {t("routines.RoutineTriggerWizard.sendEventFrom", { source: sourceName })}
              </p>
              <p className="text-sm text-muted-foreground">
                {github
                  ? t("routines.RoutineTriggerWizard.githubTestHelp")
                  : t("routines.RoutineTriggerWizard.appTestHelp")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("routines.RoutineTriggerWizard.keepPageOpen")}
              </p>
            </div>
            <div
              role="status"
              className="flex items-start gap-3 rounded-md bg-muted/40 p-4"
            >
              {checkResult === "received" ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-(--status-task-done)" />
              ) : checkResult === "rejected" ? (
                <AlertCircle className="h-5 w-5 shrink-0 text-destructive" />
              ) : (
                <Radio className="h-5 w-5 shrink-0 text-muted-foreground" />
              )}
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {checkResult === "received"
                    ? t("routines.RoutineTriggerWizard.statusReceived")
                    : checkResult === "rejected"
                      ? t("routines.RoutineTriggerWizard.statusRejected")
                      : checkResult === "no_event"
                        ? t("routines.RoutineTriggerWizard.statusNoEvent")
                        : t("routines.RoutineTriggerWizard.statusWaiting")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {checkResult === "received"
                    ? t("routines.RoutineTriggerWizard.detailReceived")
                    : checkResult === "rejected"
                      ? t("routines.RoutineTriggerWizard.detailRejected")
                      : t("routines.RoutineTriggerWizard.detailWaiting")}
                </p>
              </div>
            </div>
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {t("routines.RoutineTriggerWizard.troubleshoot")}
              </summary>
              <div className="space-y-3 pt-3">
                <p className="text-xs text-muted-foreground">
                  {t("routines.RoutineTriggerWizard.troubleshootDetail")}
                </p>
                <CopyField label={t("routines.RoutineTriggerWizard.webhookUrl")} value={webhookUrl} />
              </div>
            </details>
          </div>
        )}
        {!schedule && draft.step === 2 && (
          <p className="text-xs text-muted-foreground">
            {routineActive
              ? t("routines.RoutineTriggerWizard.finishEnable")
              : t("routines.RoutineTriggerWizard.finishSave")}
          </p>
        )}
        {schedule && draft.step === 2 && !routineActive && (
          <p className="text-sm text-muted-foreground">
            {t("routines.RoutineTriggerWizard.routinePaused")}
          </p>
        )}
        {saveError && (
          <p role="alert" className="text-sm text-destructive">
            {saveError}
          </p>
        )}
        <SetupWizardFooter onSaveExit={saveAndExit}>
          {draft.step > 0 && goBack}
          {draft.step === 0 ? (
            <Button disabled={draft.kind === "choose"} onClick={advance}>
              {t("routines.RoutineTriggerWizard.continue")}
            </Button>
          ) : schedule ? (
            draft.step === 1 ? (
              <Button disabled={!draft.time} onClick={advance}>
                {t("routines.RoutineTriggerWizard.reviewSchedule")}
              </Button>
            ) : (
              <Button onClick={() => void perform(() => onFinish(draft))}>
                {t("routines.RoutineTriggerWizard.addSchedule")}
              </Button>
            )
          ) : draft.step === 1 ? (
            <Button onClick={advance}>{t("routines.RoutineTriggerWizard.checkConnection")}</Button>
          ) : (
            <Button onClick={() => void perform(() => onFinish(draft))}>
              {checkResult === "received"
                ? t("routines.RoutineTriggerWizard.finishSetup")
                : t("routines.RoutineTriggerWizard.finishWithoutChecking")}
            </Button>
          )}
        </SetupWizardFooter>
      </fieldset>
    </div>
  );
}
