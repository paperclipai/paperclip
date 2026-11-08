import { t as finalPagesT } from "@/i18n";
import { t as translateShell, useTranslation } from "@/i18n";
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
  { key: "statusTransitions", get label() { return translateShell("shell:became_blocked_needs_review_done_cancelled"); } },
  { key: "membershipChanges", get label() { return translateShell("shell:new_issue_matches_the_query_issue_leaves"); } },
  { key: "humanComments", get label() { return translateShell("shell:human_comments"); } },
  { key: "assigneeChanges", get label() { return translateShell("shell:assignee_changes"); } },
  { key: "anyUpdate", get label() { return translateShell("shell:any_update_at_all_noisy_includes_in"); }, noisy: true },
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
  const { t: translateShell } = useTranslation("shell");
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
  const { t: translateShell } = useTranslation("shell");
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
        <h3 className="text-sm font-semibold">{translateShell("shell:auto_update_policy")}</h3>
        <div className="space-y-2">
          <RadioRow
            selected={policy.mode === "manual"}
            title={translateShell("shell:manual_only_updates_when_i_press_refresh")}
            badge={
              <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-(length:--text-nano) font-medium uppercase tracking-wide text-muted-foreground">{translateShell("shell:default")}</span>
            }
            onSelect={() => setMode("manual")}
          />
          <RadioRow
            selected={policy.mode === "interval"}
            title={translateShell("shell:on_a_schedule_only_if_something_changed")}
            onSelect={() => setMode("interval")}
          >
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>{translateShell("shell:check_every")}</span>
              <Select
                value={String(policy.intervalMinutes ?? 15)}
                onValueChange={(next) => setPolicy({ intervalMinutes: Number(next) })}
              >
                <SelectTrigger size="sm" className="w-28" aria-label={translateShell("shell:check_interval")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTERVAL_OPTIONS.map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>{translateShell("shell:min", { value1: minutes })}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </RadioRow>
          <RadioRow
            selected={policy.mode === "reactive"}
            title={translateShell("shell:as_soon_as_something_changes_debounced")}
            onSelect={() => setMode("reactive")}
          >
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>{translateShell("shell:wait")}</span>
              <Select
                value={String(policy.debounceSeconds ?? 60)}
                onValueChange={(next) => setPolicy({ debounceSeconds: Number(next) })}
              >
                <SelectTrigger size="sm" className="w-24" aria-label={translateShell("shell:debounce")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DEBOUNCE_OPTIONS.map((seconds) => (
                    <SelectItem key={seconds} value={String(seconds)}>
                      {finalPagesT("final-pages:seconds_s_c98e00", { seconds })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs">{translateShell("shell:after_the_last_change_max")}</span>
              <Input
                type="number"
                min={1}
                max={60}
                value={policy.maxUpdatesPerHour ?? 6}
                onChange={(event) => setPolicy({ maxUpdatesPerHour: Math.max(1, Number(event.target.value) || 1) })}
                className="h-8 w-16 text-sm"
                aria-label={translateShell("shell:max_updates_per_hour")}
              />
              <span className="text-xs">{translateShell("shell:updates_hour")}</span>
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
          <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-3 py-2.5 text-sm font-semibold">{translateShell("shell:advanced")}<ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-6 border-t border-border px-3 py-3">
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">{translateShell("shell:count_as_a_change")}</h3>
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
              <h3 className="text-sm font-semibold">{translateShell("shell:guardrails")}</h3>
              <label className="flex items-start gap-2.5 text-sm">
                <Checkbox checked={Boolean(activeHours)} onCheckedChange={(checked) => setActiveHoursEnabled(Boolean(checked))} className="mt-0.5" aria-label={translateShell("shell:limit_to_active_hours")} />
                <span>{translateShell("shell:only_auto_update_during_active_hours")}</span>
              </label>
              {activeHours ? (
                <div className="flex flex-wrap items-center gap-2 pl-6 text-sm">
                  <Input
                    type="time"
                    value={activeHours.start}
                    onChange={(event) => setPolicy({ activeHours: { ...activeHours, start: event.target.value } })}
                    className="h-8 w-32"
                    aria-label={translateShell("shell:active_hours_start")}
                  />
                  <span className="text-muted-foreground">–</span>
                  <Input
                    type="time"
                    value={activeHours.end}
                    onChange={(event) => setPolicy({ activeHours: { ...activeHours, end: event.target.value } })}
                    className="h-8 w-32"
                    aria-label={translateShell("shell:active_hours_end")}
                  />
                  <Input
                    value={activeHours.timezone}
                    onChange={(event) => setPolicy({ activeHours: { ...activeHours, timezone: event.target.value } })}
                    className="h-8 w-40"
                    placeholder={translateShell("shell:timezone")}
                    aria-label={translateShell("shell:active_hours_timezone")}
                  />
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-32 shrink-0">{translateShell("shell:daily_token_cap")}</span>
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
                  placeholder={translateShell("shell:no_cap")}
                  aria-label={translateShell("shell:daily_token_cap")}
                />
              </div>
            </section>
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      <div className="flex items-center gap-2 text-sm">
        <span className="font-semibold">{translateShell("shell:estimated_cost")}</span>
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
            <p className="mt-1 opacity-80">{translateShell("shell:rough_estimate_from_typical_update_sizes_actual")}</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
