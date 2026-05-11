import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { X } from "lucide-react";

// ---------------------------------------------------------------------------
// Public (stable) types & helpers
// ---------------------------------------------------------------------------

/**
 * Limited preset set kept for backwards compatibility. `parseCronToPreset` and
 * the `describeSchedule` fallback rely on this set. Any cron that can't be
 * expressed with a single hour / minute / day-of-week / day-of-month routes
 * to "custom" from this parser so old callers never see a lossy preset.
 */
export type SchedulePreset =
  | "every_minute"
  | "every_hour"
  | "every_day"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "custom";

const DAY_NAMES_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function ordinalSuffix(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

function ordinal(n: number): string {
  return `${n}${ordinalSuffix(n)}`;
}

function isSimpleCronField(field: string): boolean {
  return field === "*" || /^\d+$/.test(field);
}

function parseTimeParts(time: string): { hour: number; minute: number } | null {
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

function hasSingleMinuteAcrossTimes(times: string[]): boolean {
  const parsed = times.map(parseTimeParts);
  if (parsed.some((value) => value == null)) return false;
  const minutes = new Set(parsed.map((value) => value!.minute));
  return minutes.size <= 1;
}

// ---------------------------------------------------------------------------
// Back-compat parser (kept so tests and any external callers continue to work)
// ---------------------------------------------------------------------------

/**
 * Parse a cron into one of the *limited* presets (original behaviour).
 * Complex expressions (comma lists, ranges, steps, named tokens) all map to
 * "custom" so the caller can safely round-trip the raw string without losing
 * multi-value information. Don't change these semantics without updating the
 * ScheduleEditor tests — they intentionally guard against silent collapse of
 * multi-value crons like `0 9,13,17 * * *`.
 */
export function parseCronToPreset(cron: string): {
  preset: SchedulePreset;
  hour: string;
  minute: string;
  dayOfWeek: string;
  dayOfMonth: string;
} {
  const defaults = { hour: "10", minute: "0", dayOfWeek: "1", dayOfMonth: "1" };

  if (!cron || !cron.trim()) {
    return { preset: "every_day", ...defaults };
  }

  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { preset: "custom", ...defaults };
  }

  const [min, hr, dom, month, dow] = parts;
  const dowIsWeekdayRange = dow === "1-5";
  const allFieldsSimple =
    isSimpleCronField(min) &&
    isSimpleCronField(hr) &&
    isSimpleCronField(dom) &&
    isSimpleCronField(month) &&
    (isSimpleCronField(dow) || dowIsWeekdayRange);
  if (!allFieldsSimple) {
    return { preset: "custom", ...defaults };
  }
  if (month !== "*") {
    return { preset: "custom", ...defaults };
  }

  if (min === "*" && hr === "*" && dom === "*" && dow === "*") {
    return { preset: "every_minute", ...defaults };
  }
  if (hr === "*" && dom === "*" && dow === "*") {
    return { preset: "every_hour", ...defaults, minute: min === "*" ? "0" : min };
  }
  if (dom === "*" && dow === "*" && hr !== "*") {
    return { preset: "every_day", ...defaults, hour: hr, minute: min === "*" ? "0" : min };
  }
  if (dom === "*" && dow === "1-5" && hr !== "*") {
    return { preset: "weekdays", ...defaults, hour: hr, minute: min === "*" ? "0" : min };
  }
  if (dom === "*" && /^\d$/.test(dow) && hr !== "*") {
    return {
      preset: "weekly",
      ...defaults,
      hour: hr,
      minute: min === "*" ? "0" : min,
      dayOfWeek: dow,
    };
  }
  if (/^\d{1,2}$/.test(dom) && dow === "*" && hr !== "*") {
    return {
      preset: "monthly",
      ...defaults,
      hour: hr,
      minute: min === "*" ? "0" : min,
      dayOfMonth: dom,
    };
  }
  return { preset: "custom", ...defaults };
}

// ---------------------------------------------------------------------------
// Richer internal parser that can handle multi-value fields
// ---------------------------------------------------------------------------

type EditorPreset =
  | "every_minute"
  | "every_n_minutes"
  | "hourly"
  | "every_n_hours"
  | "daily"
  | "weekdays"
  | "monthly"
  | "custom";

interface EditorState {
  preset: EditorPreset;
  n: number; // every_n_minutes, every_n_hours
  windowEnabled: boolean;
  windowStart: number;
  windowEnd: number;
  weekdaysOnly: boolean;
  minutePast: number; // hourly, every_n_hours
  times: string[]; // "HH:mm" strings, for daily / weekdays / monthly
  days: number[]; // 0-6, for weekdays preset
  domDays: number[]; // 1-31, for monthly
  custom: string;
}

const DEFAULT_STATE: EditorState = {
  preset: "daily",
  n: 15,
  windowEnabled: false,
  windowStart: 9,
  windowEnd: 17,
  weekdaysOnly: false,
  minutePast: 0,
  times: ["09:00"],
  days: [1, 2, 3, 4, 5],
  domDays: [1],
  custom: "0 10 * * *",
};

function parseCronField(field: string, min: number, max: number): number[] {
  if (field === "*") {
    return Array.from({ length: max - min + 1 }, (_, i) => i + min);
  }
  const parts = field.split(",");
  const out = new Set<number>();
  for (const p of parts) {
    if (!p) {
      throw new Error("Invalid cron field");
    }
    const stepMatch = p.match(/^(.+)\/(\d+)$/);
    let base = p;
    let step = 1;
    if (stepMatch) {
      base = stepMatch[1];
      step = parseInt(stepMatch[2], 10);
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error("Invalid cron step");
      }
    }
    if (base === "*") {
      for (let i = min; i <= max; i += step) out.add(i);
    } else if (base.includes("-")) {
      if (!/^\d+-\d+$/.test(base)) {
        throw new Error("Invalid cron range");
      }
      const [a, b] = base.split("-").map(Number);
      if (a > b) {
        throw new Error("Invalid cron range");
      }
      for (let i = a; i <= b; i += step) out.add(i);
    } else {
      if (!/^\d+$/.test(base)) {
        throw new Error("Invalid cron value");
      }
      const n = parseInt(base, 10);
      out.add(n);
    }
  }
  for (const value of out) {
    if (value < min || value > max) {
      throw new Error("Cron value out of range");
    }
  }
  const sorted = [...out].sort((a, b) => a - b);
  if (sorted.length === 0) {
    throw new Error("Invalid cron field");
  }
  return sorted;
}

function timesFromFields(minuteField: string, hourField: string): string[] | null {
  const minutes = parseCronField(minuteField, 0, 59);
  const hours = parseCronField(hourField, 0, 23);
  if (minutes.length > 1) {
    return null;
  }
  const out: string[] = [];
  for (const h of hours) for (const mi of minutes) out.push(`${pad(h)}:${pad(mi)}`);
  return out.length > 0 && out.length <= 24 ? out : null;
}

function parseCronToEditorState(cron: string): EditorState {
  if (!cron || !cron.trim()) return { ...DEFAULT_STATE };

  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return { ...DEFAULT_STATE, preset: "custom", custom: cron };
  const [m, h, dom, mon, dow] = fields;

  // validate each field is parseable
  try {
    parseCronField(m, 0, 59);
    parseCronField(h, 0, 23);
    parseCronField(dom, 1, 31);
    parseCronField(mon, 1, 12);
    parseCronField(dow.replace(/7/g, "0"), 0, 6);
  } catch {
    return { ...DEFAULT_STATE, preset: "custom", custom: cron };
  }

  // non-wildcard month → custom
  if (mon !== "*") return { ...DEFAULT_STATE, preset: "custom", custom: cron };

  // every minute
  if (cron.trim() === "* * * * *") return { ...DEFAULT_STATE, preset: "every_minute" };

  // every N minutes (optionally windowed / weekdays-only)
  const minuteStep = m.match(/^\*\/(\d+)$/);
  const hourRange = h.match(/^(\d+)-(\d+)$/);
  if (minuteStep && dom === "*") {
    const n = parseInt(minuteStep[1], 10);
    const state = { ...DEFAULT_STATE, preset: "every_n_minutes" as EditorPreset, n };
    if (h !== "*") {
      if (hourRange) {
        state.windowEnabled = true;
        state.windowStart = +hourRange[1];
        state.windowEnd = +hourRange[2];
      } else {
        // unsupported hour field for this preset → custom
        return { ...DEFAULT_STATE, preset: "custom", custom: cron };
      }
    }
    if (dow === "1-5") state.weekdaysOnly = true;
    else if (dow !== "*") return { ...DEFAULT_STATE, preset: "custom", custom: cron };
    return state;
  }

  // hourly: single minute, hour=*
  if (/^\d+$/.test(m) && h === "*" && dom === "*" && dow === "*") {
    return { ...DEFAULT_STATE, preset: "hourly", minutePast: parseInt(m, 10) };
  }
  if (/^\d+$/.test(m) && h === "*" && dom === "*" && dow !== "*") {
    return { ...DEFAULT_STATE, preset: "custom", custom: cron };
  }

  // every N hours
  const hourStep = h.match(/^\*\/(\d+)$/);
  if (/^\d+$/.test(m) && hourStep && dom === "*") {
    const state = {
      ...DEFAULT_STATE,
      preset: "every_n_hours" as EditorPreset,
      n: parseInt(hourStep[1], 10),
      minutePast: parseInt(m, 10),
    };
    if (dow === "1-5") state.weekdaysOnly = true;
    else if (dow !== "*") return { ...DEFAULT_STATE, preset: "custom", custom: cron };
    return state;
  }

  // monthly: specific dom (may be multi), dow = *
  if (dom !== "*" && dow === "*") {
    const domDays = parseCronField(dom, 1, 31);
    const times = timesFromFields(m, h);
    if (!times) return { ...DEFAULT_STATE, preset: "custom", custom: cron };
    if (domDays.length === 0) return { ...DEFAULT_STATE, preset: "custom", custom: cron };
    return {
      ...DEFAULT_STATE,
      preset: "monthly",
      domDays,
      times,
    };
  }

  // weekdays (any subset of days)
  if (dom === "*" && dow !== "*") {
    const days = parseCronField(dow.replace(/7/g, "0"), 0, 6);
    const times = timesFromFields(m, h);
    if (!times) return { ...DEFAULT_STATE, preset: "custom", custom: cron };
    if (days.length === 0) return { ...DEFAULT_STATE, preset: "custom", custom: cron };
    return {
      ...DEFAULT_STATE,
      preset: "weekdays",
      days,
      times,
    };
  }

  // daily (any time(s))
  if (dom === "*" && dow === "*") {
    const times = timesFromFields(m, h);
    if (!times) return { ...DEFAULT_STATE, preset: "custom", custom: cron };
    return {
      ...DEFAULT_STATE,
      preset: "daily",
      times,
    };
  }

  return { ...DEFAULT_STATE, preset: "custom", custom: cron };
}

function buildCronFromState(s: EditorState): string {
  const fmt = (arr: number[] | string): string => {
    if (typeof arr === "string") return arr;
    if (arr.length === 0) return "*";
    return arr.join(",");
  };
  const isWeekdayRangeSelection = (days: number[]): boolean =>
    days.length === 5 && days.every((day, index) => day === index + 1);
  switch (s.preset) {
    case "every_minute":
      return "* * * * *";
    case "every_n_minutes": {
      const hourField = s.windowEnabled ? `${s.windowStart}-${s.windowEnd}` : "*";
      const dowField = s.weekdaysOnly ? "1-5" : "*";
      return `*/${s.n} ${hourField} * * ${dowField}`;
    }
    case "hourly":
      return `${s.minutePast} * * * *`;
    case "every_n_hours": {
      const dowField = s.weekdaysOnly ? "1-5" : "*";
      return `${s.minutePast} */${s.n} * * ${dowField}`;
    }
    case "daily": {
      const parsedTimes = s.times.map(parseTimeParts).filter((value): value is NonNullable<typeof value> => value != null);
      const minute = parsedTimes[0]?.minute ?? 0;
      const hours = [...new Set(parsedTimes.map((time) => time.hour))].sort((a, b) => a - b);
      return `${minute} ${fmt(hours)} * * *`;
    }
    case "weekdays": {
      const parsedTimes = s.times.map(parseTimeParts).filter((value): value is NonNullable<typeof value> => value != null);
      const minute = parsedTimes[0]?.minute ?? 0;
      const hours = [...new Set(parsedTimes.map((time) => time.hour))].sort((a, b) => a - b);
      const days = s.days.length === 0
        ? "*"
        : isWeekdayRangeSelection(s.days)
          ? "1-5"
          : s.days.slice().sort((a, b) => a - b).join(",");
      return `${minute} ${fmt(hours)} * * ${days}`;
    }
    case "monthly": {
      const parsedTimes = s.times.map(parseTimeParts).filter((value): value is NonNullable<typeof value> => value != null);
      const minute = parsedTimes[0]?.minute ?? 0;
      const hours = [...new Set(parsedTimes.map((time) => time.hour))].sort((a, b) => a - b);
      const doms = s.domDays.length === 0 ? [1] : s.domDays.slice().sort((a, b) => a - b);
      return `${minute} ${fmt(hours)} ${fmt(doms)} * *`;
    }
    case "custom":
      return s.custom;
  }
}

// ---------------------------------------------------------------------------
// Rich describer that handles multi-value fields
// ---------------------------------------------------------------------------

/**
 * Produce a human-readable description of a cron expression. Handles
 * multi-value time and day fields (e.g. `0 9,13,17 * * 1-5` becomes
 * "Every weekday at 09:00, 13:00 and 17:00"). Falls back to the raw cron
 * expression when it can't confidently describe the schedule.
 */
export function describeSchedule(cron: string): string {
  if (!cron || !cron.trim()) return "Every day at 10:00";
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return cron;
  const [m, h, dom, mon, dow] = fields;

  let minutes: number[], hours: number[], daysOfWeek: number[], daysOfMonth: number[];
  try {
    minutes = parseCronField(m, 0, 59);
    hours = parseCronField(h, 0, 23);
    daysOfMonth = parseCronField(dom, 1, 31);
    parseCronField(mon, 1, 12);
    daysOfWeek = parseCronField(dow.replace(/7/g, "0"), 0, 6);
  } catch {
    return cron;
  }
  if (mon !== "*") return cron;

  if (minutes.length === 60 && hours.length === 24) return "Every minute";

  const minStep = m.match(/^\*\/(\d+)$/);
  if (minStep && h === "*" && dom === "*" && dow === "*") {
    return `Every ${minStep[1]} minutes`;
  }
  if (minStep && h === "*" && dom === "*" && dow === "1-5") {
    return `Every ${minStep[1]} minutes, weekdays`;
  }
  const hourRange = h.match(/^(\d+)-(\d+)$/);
  if (minStep && hourRange && dom === "*") {
    const dayPart = dow === "1-5" ? "weekdays" : dow === "*" ? "every day" : "selected days";
    return `Every ${minStep[1]} minutes between ${pad(+hourRange[1])}:00 and ${pad(+hourRange[2])}:00, ${dayPart}`;
  }
  if (minutes.length === 1 && h === "*" && dom === "*" && dow === "*") {
    return `Every hour at :${pad(minutes[0])}`;
  }
  const hourStep = h.match(/^\*\/(\d+)$/);
  if (minutes.length === 1 && hourStep && dom === "*") {
    const dayPart = dow === "1-5" ? ", weekdays" : "";
    return `Every ${hourStep[1]} hours at :${pad(minutes[0])}${dayPart}`;
  }

  // day phrase
  let dayPart = "";
  if (dom === "*" && dow === "*") dayPart = "every day";
  else if (dom === "*" && dow === "1-5") dayPart = "every weekday";
  else if (dom === "*" && (dow === "0,6" || dow === "6,0")) dayPart = "every weekend";
  else if (dom === "*") {
    if (daysOfWeek.length === 1) dayPart = `every ${DAY_NAMES_LONG[daysOfWeek[0]]}`;
    else dayPart = `every ${daysOfWeek.map((d) => DAY_NAMES_SHORT[d]).join(", ")}`;
  } else if (dow === "*") {
    if (daysOfMonth.length === 1) dayPart = `on the ${ordinal(daysOfMonth[0])} of the month`;
    else dayPart = `on the ${daysOfMonth.map(ordinal).join(", ")} of the month`;
  } else {
    return cron;
  }

  // time phrase
  const timeStrs: string[] = [];
  for (const hh of hours) for (const mi of minutes) timeStrs.push(`${pad(hh)}:${pad(mi)}`);
  let timePart = "";
  if (timeStrs.length === 1) timePart = `at ${timeStrs[0]}`;
  else if (timeStrs.length <= 4) {
    timePart = `at ${timeStrs.slice(0, -1).join(", ")} and ${timeStrs[timeStrs.length - 1]}`;
  } else timePart = `${timeStrs.length} times per day`;

  const sentence = `${dayPart} ${timePart}`.replace(/\s+/g, " ").trim();
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const PRESET_OPTIONS: { value: EditorPreset; label: string }[] = [
  { value: "every_minute", label: "Every minute" },
  { value: "every_n_minutes", label: "Every N minutes" },
  { value: "hourly", label: "Hourly" },
  { value: "every_n_hours", label: "Every N hours" },
  { value: "daily", label: "Daily — at one or more times" },
  { value: "weekdays", label: "On selected days of the week" },
  { value: "monthly", label: "Monthly — on selected dates" },
  { value: "custom", label: "Custom (cron expression)" },
];

function TimeList({
  times,
  onChange,
}: {
  times: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      {times.map((t, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            type="time"
            value={t}
            className="font-mono w-32"
            onChange={(e) => {
              const next = times.slice();
              const value = e.target.value || "00:00";
              next[i] = value;
              if (next.length > 1) {
                const parsed = parseTimeParts(value);
                if (parsed) {
                  for (let idx = 0; idx < next.length; idx += 1) {
                    const current = parseTimeParts(next[idx] ?? "");
                    const hour = idx === i ? parsed.hour : (current?.hour ?? 0);
                    next[idx] = `${pad(hour)}:${pad(parsed.minute)}`;
                  }
                }
              }
              onChange(next);
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={times.length <= 1}
            onClick={() => {
              const next = times.filter((_, idx) => idx !== i);
              onChange(next);
            }}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...times, "12:00"])}
      >
        + Add time
      </Button>
    </div>
  );
}

function DayOfWeekPicker({
  days,
  onChange,
}: {
  days: number[];
  onChange: (next: number[]) => void;
}) {
  const letters = ["S", "M", "T", "W", "T", "F", "S"];
  return (
    <div className="flex gap-1.5 flex-wrap">
      {letters.map((l, i) => {
        const active = days.includes(i);
        return (
          <Button
            key={i}
            type="button"
            variant={active ? "default" : "outline"}
            size="sm"
            className="h-9 w-9 p-0"
            title={DAY_NAMES_LONG[i]}
            onClick={() => {
              const next = active ? days.filter((d) => d !== i) : [...days, i].sort((a, b) => a - b);
              onChange(next.length === 0 ? [i] : next);
            }}
          >
            {l}
          </Button>
        );
      })}
    </div>
  );
}

function DayOfMonthPicker({
  domDays,
  onChange,
}: {
  domDays: number[];
  onChange: (next: number[]) => void;
}) {
  return (
    <div className="grid grid-cols-7 sm:grid-cols-10 gap-1.5">
      {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => {
        const active = domDays.includes(d);
        return (
          <Button
            key={d}
            type="button"
            variant={active ? "default" : "outline"}
            size="sm"
            className="h-8 px-0 text-xs"
            onClick={() => {
              const next = active ? domDays.filter((x) => x !== d) : [...domDays, d].sort((a, b) => a - b);
              onChange(next.length === 0 ? [d] : next);
            }}
          >
            {d}
          </Button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScheduleEditor component (rich)
// ---------------------------------------------------------------------------

export function ScheduleEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (cron: string) => void;
}) {
  const [state, setState] = useState<EditorState>(() => parseCronToEditorState(value));

  // Sync when external value changes and isn't the same cron we just emitted.
  useEffect(() => {
    const currentCron = buildCronFromState(state);
    if (currentCron !== value) {
      setState(parseCronToEditorState(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const emitState = useCallback(
    (next: EditorState) => {
      setState(next);
      onChange(buildCronFromState(next));
    },
    [onChange],
  );

  const update = useCallback(
    <K extends keyof EditorState>(patch: Pick<EditorState, K> | Partial<EditorState>) => {
      emitState({ ...state, ...patch });
    },
    [emitState, state],
  );

  const { preset } = state;

  return (
    <div className="space-y-4">
      {/* Preset */}
      <div className="space-y-1.5">
        <Label className="text-xs">Schedule</Label>
        <Select value={preset} onValueChange={(p) => emitState(changePreset(state, p as EditorPreset))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRESET_OPTIONS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {preset === "every_minute" && (
        <p className="text-xs text-muted-foreground">
          No options — runs every minute, around the clock.
        </p>
      )}

      {preset === "every_n_minutes" && (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Run every</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={59}
                className="w-24 font-mono"
                value={state.n}
                onChange={(e) => update({ n: clamp(+e.target.value || 1, 1, 59) })}
              />
              <span className="text-sm text-muted-foreground">minutes</span>
            </div>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {[1, 5, 10, 15, 20, 30].map((v) => (
                <Badge
                  key={v}
                  variant="outline"
                  className="cursor-pointer hover:bg-accent"
                  onClick={() => update({ n: v })}
                >
                  {v}
                </Badge>
              ))}
            </div>
          </div>
          <WindowAndWeekdaysToggles state={state} update={update} />
        </div>
      )}

      {preset === "hourly" && (
        <div className="space-y-1.5">
          <Label className="text-xs">Minute past the hour</Label>
          <Input
            type="number"
            min={0}
            max={59}
            className="w-24 font-mono"
            value={state.minutePast}
            onChange={(e) => update({ minutePast: clamp(+e.target.value || 0, 0, 59) })}
          />
          <p className="text-xs text-muted-foreground">
            Runs once an hour at <span className="font-mono">:{pad(state.minutePast)}</span>
          </p>
        </div>
      )}

      {preset === "every_n_hours" && (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Run every</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={23}
                className="w-24 font-mono"
                value={state.n}
                onChange={(e) => update({ n: clamp(+e.target.value || 1, 1, 23) })}
              />
              <span className="text-sm text-muted-foreground">hours</span>
            </div>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {[1, 2, 3, 4, 6, 8, 12].map((v) => (
                <Badge
                  key={v}
                  variant="outline"
                  className="cursor-pointer hover:bg-accent"
                  onClick={() => update({ n: v })}
                >
                  {v}
                </Badge>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Minute past the hour</Label>
            <Input
              type="number"
              min={0}
              max={59}
              className="w-24 font-mono"
              value={state.minutePast}
              onChange={(e) => update({ minutePast: clamp(+e.target.value || 0, 0, 59) })}
            />
          </div>
          <WeekdaysOnlyToggle state={state} update={update} />
        </div>
      )}

      {preset === "daily" && (
        <div className="space-y-1.5">
          <Label className="text-xs">Times of day</Label>
          <TimeList times={state.times} onChange={(times) => update({ times })} />
          {state.times.length > 1 && (
            <p className="text-xs text-muted-foreground">
              All times in one schedule share the same minute. Changing one minute updates them all.
            </p>
          )}
        </div>
      )}

      {preset === "weekdays" && (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Days of the week</Label>
            <DayOfWeekPicker days={state.days} onChange={(days) => update({ days })} />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {(
                [
                  ["Weekdays", [1, 2, 3, 4, 5]],
                  ["Weekends", [0, 6]],
                  ["All days", [0, 1, 2, 3, 4, 5, 6]],
                  ["Mon · Wed · Fri", [1, 3, 5]],
                  ["Tue · Thu", [2, 4]],
                ] as const
              ).map(([label, days]) => (
                <Badge
                  key={label}
                  variant="outline"
                  className="cursor-pointer hover:bg-accent"
                  onClick={() => update({ days: [...days] })}
                >
                  {label}
                </Badge>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Times of day</Label>
            <TimeList times={state.times} onChange={(times) => update({ times })} />
            {state.times.length > 1 && (
              <p className="text-xs text-muted-foreground">
                All times in one schedule share the same minute. Changing one minute updates them all.
              </p>
            )}
          </div>
        </div>
      )}

      {preset === "monthly" && (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Days of the month</Label>
            <DayOfMonthPicker domDays={state.domDays} onChange={(domDays) => update({ domDays })} />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {(
                [
                  ["1st only", [1]],
                  ["15th only", [15]],
                  ["1st & 15th", [1, 15]],
                  ["Last day (28th)", [28]],
                ] as const
              ).map(([label, days]) => (
                <Badge
                  key={label}
                  variant="outline"
                  className="cursor-pointer hover:bg-accent"
                  onClick={() => update({ domDays: [...days] })}
                >
                  {label}
                </Badge>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Days 29–31 are skipped in months that don't have them.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Times of day</Label>
            <TimeList times={state.times} onChange={(times) => update({ times })} />
            {state.times.length > 1 && (
              <p className="text-xs text-muted-foreground">
                All times in one schedule share the same minute. Changing one minute updates them all.
              </p>
            )}
          </div>
        </div>
      )}

      {preset === "custom" && (
        <div className="space-y-1.5">
          <Label className="text-xs">Cron expression</Label>
          <Input
            value={state.custom}
            onChange={(e) => update({ custom: e.target.value })}
            placeholder="0 10 * * *"
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Five fields: minute hour day-of-month month day-of-week
          </p>
        </div>
      )}

      <Separator />

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="text-xs">
          <span className="text-muted-foreground">Summary — </span>
          <span className="font-medium">{describeSchedule(buildCronFromState(state))}</span>
        </div>
        <code className="text-xs font-mono text-muted-foreground">
          {buildCronFromState(state)}
        </code>
      </div>
    </div>
  );
}

function WindowAndWeekdaysToggles({
  state,
  update,
}: {
  state: EditorState;
  update: (patch: Partial<EditorState>) => void;
}) {
  return (
    <>
      <div className="space-y-2">
        <label className="flex items-center gap-2 cursor-pointer text-sm">
          <Checkbox
            checked={state.windowEnabled}
            onCheckedChange={(checked) => update({ windowEnabled: checked === true })}
          />
          <span>Only between certain hours</span>
        </label>
        {state.windowEnabled && (
          <div className="flex items-center gap-2 pl-6 flex-wrap">
            <Select
              value={String(state.windowStart)}
              onValueChange={(v) => {
                const windowStart = Number(v);
                update({
                  windowStart,
                  windowEnd: Math.max(state.windowEnd, windowStart),
                });
              }}
            >
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 24 }, (_, i) => (
                  <SelectItem key={i} value={String(i)}>
                    {pad(i)}:00
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">to</span>
            <Select
              value={String(state.windowEnd)}
              onValueChange={(v) => update({ windowEnd: Math.max(Number(v), state.windowStart) })}
            >
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 24 }, (_, i) => (
                  <SelectItem key={i} value={String(i)} disabled={i < state.windowStart}>
                    {pad(i)}:00
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
      <WeekdaysOnlyToggle state={state} update={update} />
    </>
  );
}

function WeekdaysOnlyToggle({
  state,
  update,
}: {
  state: EditorState;
  update: (patch: Partial<EditorState>) => void;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer text-sm">
      <Checkbox
        checked={state.weekdaysOnly}
        onCheckedChange={(checked) => update({ weekdaysOnly: checked === true })}
      />
      <span>Weekdays only (Mon–Fri)</span>
    </label>
  );
}

function changePreset(state: EditorState, next: EditorPreset): EditorState {
  // Reset ambiguous sub-state when switching presets so we don't carry
  // over a stale weekdaysOnly / windowEnabled from a sibling preset.
  switch (next) {
    case "every_minute":
      return { ...state, preset: next };
    case "every_n_minutes":
      return { ...state, preset: next, n: 15, windowEnabled: false, weekdaysOnly: false };
    case "hourly":
      return { ...state, preset: next };
    case "every_n_hours":
      return { ...state, preset: next, n: 2, weekdaysOnly: false };
    case "daily":
      return { ...state, preset: next, times: state.times.length ? state.times : ["09:00"] };
    case "weekdays":
      return {
        ...state,
        preset: next,
        days: state.days.length ? state.days : [1, 2, 3, 4, 5],
        times: state.times.length ? state.times : ["09:00"],
      };
    case "monthly":
      return {
        ...state,
        preset: next,
        domDays: state.domDays.length ? state.domDays : [1],
        times: state.times.length ? state.times : ["09:00"],
      };
    case "custom":
      return { ...state, preset: next, custom: state.custom || buildCronFromState(state) };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

export function getScheduleEditorPresetForTest(cron: string): EditorPreset {
  return parseCronToEditorState(cron).preset;
}

export function hasSingleMinuteAcrossTimesForTest(times: string[]): boolean {
  return hasSingleMinuteAcrossTimes(times);
}

export function roundTripCronForTest(cron: string): string {
  return buildCronFromState(parseCronToEditorState(cron));
}
