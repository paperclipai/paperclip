import { i18n, t, useTranslation, Trans } from "@/i18n";
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
  const common = [
    `Connect the sending app to the Paperclip routine ${JSON.stringify(routineTitle)}.`,
    `Webhook URL: ${webhookUrl}`,
    "Send an HTTP POST request with a JSON object as the body (not an array or string).",
    "Content-Type: application/json",
  ];
  const auth =
    sender === "github"
      ? [
          "In GitHub, open your repository → Settings → Webhooks → Add webhook.",
          "Use the webhook URL above as Payload URL and select application/json as Content type.",
          `Secret: ${webhookSecret}`,
          "Paste this value into GitHub’s Secret field. GitHub signs requests with X-Hub-Signature-256; do not use Bearer authentication.",
          "Select the events that should start this routine, enable the webhook, and save.",
          "To check the connection, open Recent Deliveries and redeliver an event.",
        ]
      : [
          `Secret key: ${webhookSecret}`,
          ...(signingMode === "bearer" ? [] : [
            `If the app asks for a signing secret, paste the secret key above. Paperclip accepts HMAC-SHA256 over the exact request body in ${signingMode === "fireflies_hmac" ? "X-Hub-Signature" : "X-Hub-Signature or X-Hub-Signature-256"}, formatted sha256=<hex digest>.`,
          ]),
          ...(signingMode === "fireflies_hmac" ? [] : [
            `For apps with custom headers, use Authorization: Bearer ${webhookSecret}`,
          ]),
          "Subscribe only to the events that should start this routine. Public services need a publicly reachable HTTPS URL.",
          "In the sending app, add a webhook using this URL, POST method, JSON body, and headers, then save it.",
          "Send a unique Idempotency-Key header for each event and reuse it on retries, so retrying a setup test after activation cannot start the routine.",
          'Example JSON body: {"event":"deployment.completed","environment":"production"}',
          "To check the connection, send a test event from the app or perform the action that triggers a delivery.",
        ];
  return [
    ...common,
    ...auth,
    "Open Check connection in Paperclip to see whether the event arrived and authentication passed.",
    ...(setupPending
      ? [
          "During setup, deliveries only test the connection. They do not start the routine or create a task.",
          "Finish setup in Paperclip to enable this webhook for future events. Test events are not replayed.",
        ]
      : [
          "This webhook is enabled. Deliveries can start the routine and create tasks.",
        ]),
    "Store the key securely; do not put it in source control or logs.",
  ].join("\n");
}
export function describeSchedule(draft: TriggerDraft) {
  const weekdays: Record<string, string> = { "Monday": t("final-components-a:monday_6a00dfc1"), "Tuesday": t("final-components-a:tuesday_7d8af1de"), "Wednesday": t("final-components-a:wednesday_c0a6cc82"), "Thursday": t("final-components-a:thursday_fc266206"), "Friday": t("final-components-a:friday_e21f3f37"), "Saturday": t("final-components-a:saturday_dbe35c73"), "Sunday": t("final-components-a:sunday_873fef76") };
  return draft.frequency === "daily" ? t("final-components-a:everyDayAtTime_25949eda", { time: draft.time }) : draft.frequency === "weekly" ? t("final-components-a:everyWeekdayAtTime_ef07a825", { weekday: weekdays[draft.weekday] ?? draft.weekday, time: draft.time }) : t("final-components-a:everyWeekdayAtTime_0d371b77", { time: draft.time });
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
  useTranslation("task-components");
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
            : "Couldn’t save. Please try again.",
        );
      } finally {
        setBusy(false);
      }
    },
    [busy],
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
      { label: t("task-components:addTrigger_58fd3089") },
    ]);
  }, [saveAndExit, setBreadcrumbs, routineTitle, routineId, i18n.language]);
  const schedule = draft.kind === "schedule";
  const github = draft.sender === "github";
  const labels = schedule
    ? [t("final-components-a:chooseTrigger_c28f2212"), t("final-components-a:setSchedule_22185675"), t("final-components-a:reviewSchedule_98c00356")]
    : [t("final-components-a:chooseTrigger_c28f2212"), t("final-components-a:connectYourApp_41db7f95"), t("final-components-a:checkConnection_be5dff52")];
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
      ? t("final-components-a:whenShouldThisRoutineRun_7725656f")
      : schedule
        ? draft.step === 1
          ? t("final-components-a:setASchedule_b967d9c5")
          : t("final-components-a:reviewYourSchedule_6204c309")
        : draft.step === 1
          ? t("task-components:connect_60c78691", { value1: github ? "GitHub" : t("final-components-a:yourApp_4696a335") })
          : t("final-components-a:checkYourConnection_c2886bc3");
  const subtitle =
    draft.step === 0
      ? t("final-components-a:chooseHowToStartRoutine_8515af74", { routine: routineTitle })
      : schedule
        ? draft.step === 1
          ? t("final-components-a:chooseWhenPaperclipShouldStart_3cca3d7f")
          : t("final-components-a:thisScheduleStartsTheRoutine_b549efc6")
        : draft.step === 1
          ? t("final-components-a:copyTheseDetailsIntoThe_7eaa5d90")
          : t("final-components-a:testThatEventsArriveAnd_57926d6a");
  const selectClass =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  const goBack = (
    <Button variant="outline" onClick={() => patch({ step: draft.step - 1 })}>{t("task-components:back_76900f1b")}</Button>
  );
  return (
    <div className="min-w-0 w-full max-w-2xl space-y-6">
      <SetupWizardNavigation
        takeover
        disabled={busy}
        ariaLabel={t("final-components-a:triggerSetupProgress_0e99f6bb")}
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
            <legend className="sr-only">{t("task-components:triggerType_31a9d2bd")}</legend>
            {(
              [
                {
                  kind: "schedule",
                  label: t("task-components:onASchedule_8c4f3450"),
                  detail: t("final-components-a:everyDayOnWeekdaysOr_0ae8852b"),
                  Icon: CalendarClock,
                },
                {
                  kind: "webhook",
                  label: t("task-components:whenAnotherAppSendsAWebhook_d7f97da1"),
                  detail:
                    t("final-components-a:whenSomethingHappensInGitHub_359218e1"),
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
                <Label htmlFor="repeat">{t("task-components:repeat_b6b7a006")}</Label>
                <select
                  id="repeat"
                  className={selectClass}
                  value={draft.frequency}
                  onChange={(event) => patch({ frequency: event.target.value })}
                >
                  <option value="daily">{t("task-components:everyDay_c4e42b97")}</option>
                  <option value="weekdays">{t("task-components:weekdaysMondayFriday_0ea2df5f")}</option>
                  <option value="weekly">{t("task-components:everyWeek_1b7e1851")}</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="run-time">{t("task-components:time_33b93476")}</Label>
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
                <Label htmlFor="run-day">{t("task-components:day_8f2364e1")}</Label>
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
                    <option key={day} value={day}>{t(`final-components-a:weekday_${day}`)}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="timezone">{t("task-components:timeZone_b9fe1464")}</Label>
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
              <p className="text-xs text-muted-foreground">{t("task-components:theTimeFollowsThisZoneIncludingDaylight_ea2bf434")}</p>
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
            <p className="text-sm text-muted-foreground">{t("task-components:eachScheduledRunCreatesATaskFor_ee4ebabb")}</p>
          </div>
        )}
        {draft.step === 0 && draft.kind === "webhook" && (
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">{t("task-components:whatSSendingTheWebhook_850bfd5b")}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  {
                    sender: "custom",
                    label: t("task-components:anotherAppOrScript_33687214"),
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
          <p className="text-sm text-muted-foreground">{t("task-components:publicServicesNeedAPubliclyReachableHttps_090e88c6")}</p>
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
              label={github ? t("final-components-a:payloadURL_1de5cdcf") : t("final-components-a:webhookURL_84805a75")}
              value={webhookUrl}
            />
            {!github && draft.signingMode !== "bearer" && (
              <p className="text-sm text-muted-foreground">{t("task-components:pasteThisKeyIntoYourAppS_3dd90f15")}{draft.signingMode !== "fireflies_hmac" && <>
                  {" "}{t("task-components:ifYourAppUsesCustomHeadersInstead_4d7327f2")}</>}
              </p>
            )}
            {webhookSecret ? (
              <CopyField
                label={github ? t("task-components:secret_7e32a729") : draft.signingMode === "bearer" ? t("task-components:authorizationHeaderValue_39a91b3d") : t("task-components:secretKey_f47a99eb")}
                value={!github && draft.signingMode === "bearer" ? `Bearer ${webhookSecret}` : webhookSecret}
              />
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">{t("task-components:theKeyIsHiddenAfterLeavingSetup_8e6e20d1")}</p>
                <Button
                  variant="outline"
                  onClick={() => void perform(() => onRotateKey?.())}
                >{t("task-components:generateNewKey_3a14b7bb")}</Button>
              </div>
            )}
          </div>
        )}
        {!schedule && draft.step === 2 && (
          <div className="space-y-5">
            <div className="space-y-1 rounded-md border border-border p-4">
              <p className="text-sm font-medium">{t("task-components:connectionTestOnly_fd7045f1")}</p>
              <p className="text-sm text-muted-foreground">{t("task-components:eventsReceivedDuringSetupWonTStart_ca8e4cd4")}</p>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium"><Trans ns="task-components" i18nKey="sentence_83373db0fc2b" components={{ part1: <>{github ? "GitHub" : t("task-components:yourApp_4696a335")}</> }} /></p>
              <p className="text-sm text-muted-foreground">
                {github
                  ? t("task-components:openThisWebhookInYourRepositorySettings_e2c845a5")
                  : t("task-components:lookForSendTestInYourApp_643e56b8")}
              </p>
              <p className="text-xs text-muted-foreground">{t("task-components:keepThisPageOpenToSeeThe_f5c74154")}</p>
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
                    ? t("task-components:testEventReceivedConnectionWorking_b57a6eee")
                    : checkResult === "rejected"
                      ? t("task-components:eventArrivedButTheKeyWasRejected_8ac7b7ed")
                      : checkResult === "no_event"
                        ? t("task-components:noEventReceivedYet_4d6fd6a8")
                        : t("task-components:waitingForAnEventFromYourApp_6da2e8bc")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {checkResult === "received"
                    ? t("task-components:authenticationPassedNoRoutineRunOrTask_407050a5")
                    : checkResult === "rejected"
                      ? t("task-components:goBackToConnectYourAppUpdate_d5b974d7")
                      : t("task-components:waitingToVerifyDeliveryAndAuthenticationThe_f29bb26e")}
                </p>
              </div>
            </div>
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">{t("task-components:troubleshootDelivery_f854de03")}</summary>
              <div className="space-y-3 pt-3">
                <p className="text-xs text-muted-foreground">{t("task-components:checkThatTheWebhookIsEnabledIn_a4e5ad3d")}</p>
                <CopyField label={t("final-components-a:webhookURL_84805a75")} value={webhookUrl} />
              </div>
            </details>
          </div>
        )}
        {!schedule && draft.step === 2 && (
          <p className="text-xs text-muted-foreground">
            {routineActive
              ? t("task-components:finishSetupToEnableThisWebhookFuture_391fff2b")
              : t("task-components:finishSetupToSaveThisWebhookThe_7580f066")}
          </p>
        )}
        {schedule && draft.step === 2 && !routineActive && (
          <p className="text-sm text-muted-foreground">{t("task-components:theRoutineIsPausedEnableItsAutomatic_28f90721")}</p>
        )}
        {saveError && (
          <p role="alert" className="text-sm text-destructive">
            {saveError}
          </p>
        )}
        <SetupWizardFooter onSaveExit={saveAndExit}>
          {draft.step > 0 && goBack}
          {draft.step === 0 ? (
            <Button disabled={draft.kind === "choose"} onClick={advance}>{t("task-components:continue_31fbef16")}</Button>
          ) : schedule ? (
            draft.step === 1 ? (
              <Button disabled={!draft.time} onClick={advance}>{t("task-components:reviewSchedule_98c00356")}</Button>
            ) : (
              <Button onClick={() => void perform(() => onFinish(draft))}>{t("task-components:addSchedule_79218735")}</Button>
            )
          ) : draft.step === 1 ? (
            <Button onClick={advance}>{t("task-components:checkConnection_be5dff52")}</Button>
          ) : (
            <Button onClick={() => void perform(() => onFinish(draft))}>
              {checkResult === "received"
                ? t("task-components:finishSetup_bc01ae77")
                : t("task-components:finishWithoutChecking_ccfc47b4")}
            </Button>
          )}
        </SetupWizardFooter>
      </fieldset>
    </div>
  );
}
