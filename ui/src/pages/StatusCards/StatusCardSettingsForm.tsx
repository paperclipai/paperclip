import type { StatusCardRefreshPolicy } from "@paperclipai/shared";
import { Check } from "lucide-react";

type StatusCardInstructionsMode = "none" | "append" | "replace";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface StatusCardSettingsValue {
  instructionsMode: StatusCardInstructionsMode;
  instructions: string;
  refreshPolicy: StatusCardRefreshPolicy;
}

export function defaultSettingsValue(): StatusCardSettingsValue {
  return {
    instructionsMode: "none",
    instructions: "",
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
  { key: "statusTransitions", label: "Became blocked / needs review / done / cancelled" },
  { key: "membershipChanges", label: "New issue matches the query · issue leaves the query" },
  { key: "humanComments", label: "Human comments" },
  { key: "assigneeChanges", label: "Assignee changes" },
  { key: "anyUpdate", label: "Any update at all (noisy — includes in-progress churn)", noisy: true },
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
  showInstructions = true,
}: {
  value: StatusCardSettingsValue;
  onChange: (next: StatusCardSettingsValue) => void;
  showInstructions?: boolean;
}) {
  const { refreshPolicy: policy } = value;
  // Change triggers and the active-hours window only govern *automatic* updates;
  // in Manual mode the card only refreshes on demand, so those controls are
  // dimmed to signal they don't apply (they stay editable so a policy switch
  // keeps the chosen values).
  const autoUpdating = policy.mode !== "manual";

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
      {showInstructions ? (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Extra instructions for the summarizer</h3>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Instruction mode">
            {(
              [
                { mode: "append" as const, label: "Append to the default prompt" },
                { mode: "replace" as const, label: "Replace the default prompt" },
                { mode: "none" as const, label: "No extra instructions" },
              ]
            ).map((option) => {
              const selected = value.instructionsMode === option.mode;
              return (
                <button
                  key={option.mode}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => onChange({ ...value, instructionsMode: option.mode })}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
                    selected ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-accent/40",
                  )}
                >
                  {selected ? <Check className="h-3 w-3" /> : null}
                  {option.label}
                </button>
              );
            })}
          </div>
          <Textarea
            value={value.instructions}
            onChange={(event) => onChange({ ...value, instructions: event.target.value })}
            placeholder={'e.g. Always end with "what should Dotta do next". Keep it under 8 bullets.'}
            disabled={value.instructionsMode === "none"}
            rows={3}
            className="text-sm"
          />
        </section>
      ) : null}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Auto-update policy</h3>
        <div className="space-y-2">
          <RadioRow
            selected={policy.mode === "manual"}
            title="Manual only — updates when I press refresh"
            badge={
              <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Default
              </span>
            }
            onSelect={() => setMode("manual")}
          />
          <RadioRow
            selected={policy.mode === "interval"}
            title="On a schedule, only if something changed"
            onSelect={() => setMode("interval")}
          >
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>Check every</span>
              <Select
                value={String(policy.intervalMinutes ?? 15)}
                onValueChange={(next) => setPolicy({ intervalMinutes: Number(next) })}
              >
                <SelectTrigger size="sm" className="w-28" aria-label="Check interval">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTERVAL_OPTIONS.map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>
                      {minutes} min
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs">cheap check, no agent run if nothing changed</span>
            </div>
          </RadioRow>
          <RadioRow
            selected={policy.mode === "reactive"}
            title="As soon as something changes (debounced)"
            onSelect={() => setMode("reactive")}
          >
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>Wait</span>
              <Select
                value={String(policy.debounceSeconds ?? 60)}
                onValueChange={(next) => setPolicy({ debounceSeconds: Number(next) })}
              >
                <SelectTrigger size="sm" className="w-24" aria-label="Debounce">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DEBOUNCE_OPTIONS.map((seconds) => (
                    <SelectItem key={seconds} value={String(seconds)}>
                      {seconds}s
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs">after the last change · max</span>
              <Input
                type="number"
                min={1}
                max={60}
                value={policy.maxUpdatesPerHour ?? 6}
                onChange={(event) => setPolicy({ maxUpdatesPerHour: Math.max(1, Number(event.target.value) || 1) })}
                className="h-8 w-16 text-sm"
                aria-label="Max updates per hour"
              />
              <span className="text-xs">updates/hour</span>
            </div>
          </RadioRow>
        </div>
      </section>

      <section className={cn("space-y-2", !autoUpdating && "opacity-50")}>
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">Count as a change</h3>
          {!autoUpdating ? (
            <span className="text-xs text-muted-foreground">applies to automatic updates only</span>
          ) : null}
        </div>
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
        <h3 className="text-sm font-semibold">Guardrails</h3>
        <label className={cn("flex items-start gap-2.5 text-sm", !autoUpdating && "opacity-50")}>
          <Checkbox checked={Boolean(activeHours)} onCheckedChange={(checked) => setActiveHoursEnabled(Boolean(checked))} className="mt-0.5" aria-label="Limit to active hours" />
          <span>
            Only auto-update during active hours
            {!autoUpdating ? <span className="ml-1 text-xs text-muted-foreground">(automatic updates only)</span> : null}
          </span>
        </label>
        {activeHours ? (
          <div className="flex flex-wrap items-center gap-2 pl-6 text-sm">
            <Input
              type="time"
              value={activeHours.start}
              onChange={(event) => setPolicy({ activeHours: { ...activeHours, start: event.target.value } })}
              className="h-8 w-32"
              aria-label="Active hours start"
            />
            <span className="text-muted-foreground">–</span>
            <Input
              type="time"
              value={activeHours.end}
              onChange={(event) => setPolicy({ activeHours: { ...activeHours, end: event.target.value } })}
              className="h-8 w-32"
              aria-label="Active hours end"
            />
            <Input
              value={activeHours.timezone}
              onChange={(event) => setPolicy({ activeHours: { ...activeHours, timezone: event.target.value } })}
              className="h-8 w-40"
              placeholder="Timezone"
              aria-label="Active hours timezone"
            />
            <span className="text-xs text-muted-foreground">outside these hours: batch into one update</span>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="w-32 shrink-0">Daily token cap</span>
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
            placeholder="no cap"
            aria-label="Daily token cap"
          />
          <span className="text-xs text-muted-foreground">card pauses + banner when the cap is hit</span>
        </div>
      </section>
    </div>
  );
}
