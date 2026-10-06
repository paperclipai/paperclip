import { t, useTranslation } from "@/i18n";
import type { StatusCardRefreshPolicy } from "@paperclipai/shared";
import { ChevronDown } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { estimateStatusCardCost } from "./format";

export interface StatusCardSettingsValue {
  refreshPolicy: StatusCardRefreshPolicy;
}

export function defaultSettingsValue(): StatusCardSettingsValue {
  return {
    refreshPolicy: {
      mode: "manual",
      triggers: {
        statusTransitions: true,
        membershipChanges: true,
        humanComments: true,
        assigneeChanges: true,
        anyUpdate: false,
      },
    },
  };
}

const INTERVAL_OPTIONS = [5, 15, 30, 60];
const DEBOUNCE_OPTIONS = [30, 60, 120, 300];

type TriggerKey = keyof StatusCardRefreshPolicy["triggers"];

const TRIGGER_ROWS: { key: TriggerKey; label: string; noisy?: boolean }[] = [
  { key: "statusTransitions", get label() { return t("localizationStatusCards.becameBlockedNeedsReviewDoneCancelled39"); } },
  { key: "membershipChanges", get label() { return t("localizationStatusCards.newIssueMatchesTheQueryIssueLeavesTheQuery41"); } },
  { key: "humanComments", get label() { return t("localizationStatusCards.humanComments43"); } },
  { key: "assigneeChanges", get label() { return t("localizationStatusCards.assigneeChanges45"); } },
  { key: "anyUpdate", get label() { return t("localizationStatusCards.anyUpdateAtAllNoisyIncludesInProgressChurn47"); }, noisy: true },
];

function RadioRow({
  selected,
  title,
  badge,
  onSelect,
  children,
}: {
  selected: boolean;
  title: string;
  badge?: React.ReactNode;
  onSelect: () => void;
  children?: React.ReactNode;
}) {
  useTranslation();
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2.5 transition-colors",
        selected ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:bg-accent/40",
      )}
    >
      <button type="button" role="radio" aria-checked={selected} onClick={onSelect} className="flex w-full items-center gap-2 text-left">
        <span
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
            selected ? "border-primary" : "border-muted-foreground/50",
          )}
        >
          {selected ? <span className="h-2 w-2 rounded-full bg-primary" /> : null}
        </span>
        <span className="text-sm font-medium">{title}</span>
        {badge}
      </button>
      {selected && children ? <div className="mt-2 pl-6">{children}</div> : null}
    </div>
  );
}

export function StatusCardSettingsForm({
  value,
  onChange,
}: {
  value: StatusCardSettingsValue;
  onChange: (next: StatusCardSettingsValue) => void;
}) {
  const { t } = useTranslation();
  const { refreshPolicy: policy } = value;
  // Change triggers, active-hours, and the daily token cap only govern
  // *automatic* updates. In Manual mode none of them apply, so the whole
  // "Advanced" group is hidden rather than shown-but-dimmed.
  const autoUpdating = policy.mode !== "manual";
  const costEstimate = estimateStatusCardCost(policy);

  const setPolicy = (patch: Partial<StatusCardRefreshPolicy>) =>
    onChange({ ...value, refreshPolicy: { ...policy, ...patch } });

  const setMode = (mode: StatusCardRefreshPolicy["mode"]) => {
    const patch: Partial<StatusCardRefreshPolicy> = { mode };
    if (mode === "interval") patch.intervalMinutes = policy.intervalMinutes ?? 15;
    if (mode === "reactive") {
      patch.debounceSeconds = policy.debounceSeconds ?? 60;
      patch.maxUpdatesPerHour = policy.maxUpdatesPerHour ?? 6;
    }
    setPolicy(patch);
  };

  const toggleTrigger = (key: TriggerKey) =>
    setPolicy({ triggers: { ...policy.triggers, [key]: !policy.triggers[key] } });

  const activeHours = policy.activeHours;
  const setActiveHoursEnabled = (enabled: boolean) =>
    setPolicy({
      activeHours: enabled
        ? { start: activeHours?.start ?? "08:00", end: activeHours?.end ?? "19:00", timezone: activeHours?.timezone ?? "UTC" }
        : undefined,
    });

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t("localizationStatusCards.autoUpdatePolicy51")}</h3>
        <div className="space-y-2">
          <RadioRow
            selected={policy.mode === "manual"}
            title={t("localizationStatusCards.manualOnlyUpdatesWhenIPressRefresh52")}
            badge={
              <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-(length:--text-nano) font-medium uppercase tracking-wide text-muted-foreground">{t("pages.secrets.common.default")}</span>
            }
            onSelect={() => setMode("manual")}
          />
          <RadioRow
            selected={policy.mode === "interval"}
            title={t("localizationStatusCards.onAScheduleOnlyIfSomethingChanged54")}
            onSelect={() => setMode("interval")}
          >
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>{t("localizationStatusCards.checkEvery55")}</span>
              <Select
                value={String(policy.intervalMinutes ?? 15)}
                onValueChange={(next) => setPolicy({ intervalMinutes: Number(next) })}
              >
                <SelectTrigger size="sm" className="w-28" aria-label={t("localizationStatusCards.checkInterval56")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTERVAL_OPTIONS.map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>
                      {t("localizationStatusCards.minuteOption", { count: minutes })}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </RadioRow>
          <RadioRow
            selected={policy.mode === "reactive"}
            title={t("localizationStatusCards.asSoonAsSomethingChangesDebounced58")}
            onSelect={() => setMode("reactive")}
          >
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>{t("localizationOperations.ui_Wait")}</span>
              <Select
                value={String(policy.debounceSeconds ?? 60)}
                onValueChange={(next) => setPolicy({ debounceSeconds: Number(next) })}
              >
                <SelectTrigger size="sm" className="w-24" aria-label={t("localizationStatusCards.debounce59")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DEBOUNCE_OPTIONS.map((seconds) => (
                    <SelectItem key={seconds} value={String(seconds)}>
                      {t("localizationStatusCards.secondOption", { count: seconds })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs">{t("localizationStatusCards.afterTheLastChangeMax60")}</span>
              <Input
                type="number"
                min={1}
                max={60}
                value={policy.maxUpdatesPerHour ?? 6}
                onChange={(event) => setPolicy({ maxUpdatesPerHour: Math.max(1, Number(event.target.value) || 1) })}
                className="h-8 w-16 text-sm"
                aria-label={t("localizationStatusCards.maxUpdatesPerHour61")}
              />
              <span className="text-xs">{t("localizationStatusCards.updatesHour62")}</span>
            </div>
          </RadioRow>
        </div>
      </section>

      {/*
        Change triggers, active hours, and the daily token cap only apply to
        automatic updates, so they are hidden entirely in Manual mode and tucked
        under a collapsed "Advanced" disclosure otherwise.
      */}
      {autoUpdating ? (
        <Collapsible className="rounded-md border border-border">
          <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-3 py-2.5 text-sm font-semibold">{t("pages.agentDetail.advanced")}<ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-6 border-t border-border px-3 py-3">
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">{t("localizationStatusCards.countAsAChange64")}</h3>
              <div className="space-y-2">
                {TRIGGER_ROWS.map((row) => (
                  <label key={row.key} className="flex items-start gap-2.5 text-sm">
                    <Checkbox
                      checked={policy.triggers[row.key]}
                      onCheckedChange={() => toggleTrigger(row.key)}
                      className="mt-0.5"
                      aria-label={row.label}
                    />
                    <span className={cn(row.noisy && "text-muted-foreground")}>{row.label}</span>
                  </label>
                ))}
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold">{t("localizationStatusCards.guardrails65")}</h3>
              <label className="flex items-start gap-2.5 text-sm">
                <Checkbox checked={Boolean(activeHours)} onCheckedChange={(checked) => setActiveHoursEnabled(Boolean(checked))} className="mt-0.5" aria-label={t("localizationStatusCards.limitToActiveHours66")} />
                <span>{t("localizationStatusCards.onlyAutoUpdateDuringActiveHours67")}</span>
              </label>
              {activeHours ? (
                <div className="flex flex-wrap items-center gap-2 pl-6 text-sm">
                  <Input
                    type="time"
                    value={activeHours.start}
                    onChange={(event) => setPolicy({ activeHours: { ...activeHours, start: event.target.value } })}
                    className="h-8 w-32"
                    aria-label={t("localizationStatusCards.activeHoursStart68")}
                  />
                  <span className="text-muted-foreground">–</span>
                  <Input
                    type="time"
                    value={activeHours.end}
                    onChange={(event) => setPolicy({ activeHours: { ...activeHours, end: event.target.value } })}
                    className="h-8 w-32"
                    aria-label={t("localizationStatusCards.activeHoursEnd69")}
                  />
                  <Input
                    value={activeHours.timezone}
                    onChange={(event) => setPolicy({ activeHours: { ...activeHours, timezone: event.target.value } })}
                    className="h-8 w-40"
                    placeholder={t("localizationStatusCards.timezone70")}
                    aria-label={t("localizationStatusCards.activeHoursTimezone71")}
                  />
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-32 shrink-0">{t("localizationStatusCards.dailyTokenCap72")}</span>
                <Input
                  type="number"
                  min={0}
                  step={1000}
                  value={policy.dailyTokenCap ?? ""}
                  onChange={(event) => {
                    const parsed = Number(event.target.value);
                    setPolicy({ dailyTokenCap: event.target.value === "" || parsed <= 0 ? undefined : parsed });
                  }}
                  className="h-8 w-36"
                  placeholder={t("localizationStatusCards.noCap73")}
                  aria-label={t("localizationStatusCards.dailyTokenCap72")}
                />
              </div>
            </section>
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      <div className="flex items-center gap-2 text-sm">
        <span className="font-semibold">{t("localizationStatusCards.estimatedCost74")}</span>
        <span className="text-muted-foreground">=</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default font-medium text-foreground underline decoration-dotted decoration-muted-foreground/50 underline-offset-4">
              {costEstimate.cost}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-(--sz-18rem) text-left">
            <p>{costEstimate.primary}</p>
            {costEstimate.note ? <p className="mt-1 opacity-80">{costEstimate.note}</p> : null}
            <p className="mt-1 opacity-80">{t("localizationStatusCards.roughEstimateFromTypicalUpdateSizesActualCostIsTrackedP75")}</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
