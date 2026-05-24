import { useCallback, useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "@/i18n";

type SchedulePreset = "every_minute" | "every_hour" | "every_day" | "weekdays" | "weekly" | "monthly" | "custom";

function buildPresets(t: TFunction): { value: SchedulePreset; label: string }[] {
  return [
    { value: "every_minute", label: t("scheduleEditor.preset.everyMinute", { defaultValue: "Every minute" }) },
    { value: "every_hour", label: t("scheduleEditor.preset.everyHour", { defaultValue: "Every hour" }) },
    { value: "every_day", label: t("scheduleEditor.preset.everyDay", { defaultValue: "Every day" }) },
    { value: "weekdays", label: t("scheduleEditor.preset.weekdays", { defaultValue: "Weekdays" }) },
    { value: "weekly", label: t("scheduleEditor.preset.weekly", { defaultValue: "Weekly" }) },
    { value: "monthly", label: t("scheduleEditor.preset.monthly", { defaultValue: "Monthly" }) },
    { value: "custom", label: t("scheduleEditor.preset.custom", { defaultValue: "Custom (cron)" }) },
  ];
}

function buildHours(t: TFunction) {
  return Array.from({ length: 24 }, (_, i) => {
    let label: string;
    if (i === 0) {
      label = t("scheduleEditor.hour.midnight", { defaultValue: "12 AM" });
    } else if (i < 12) {
      label = t("scheduleEditor.hour.am", { defaultValue: "{{hour}} AM", hour: i });
    } else if (i === 12) {
      label = t("scheduleEditor.hour.noon", { defaultValue: "12 PM" });
    } else {
      label = t("scheduleEditor.hour.pm", { defaultValue: "{{hour}} PM", hour: i - 12 });
    }
    return { value: String(i), label };
  });
}

const MINUTES = Array.from({ length: 12 }, (_, i) => ({
  value: String(i * 5),
  label: String(i * 5).padStart(2, "0"),
}));

function buildDaysOfWeek(t: TFunction) {
  return [
    { value: "1", label: t("scheduleEditor.day.mon", { defaultValue: "Mon" }) },
    { value: "2", label: t("scheduleEditor.day.tue", { defaultValue: "Tue" }) },
    { value: "3", label: t("scheduleEditor.day.wed", { defaultValue: "Wed" }) },
    { value: "4", label: t("scheduleEditor.day.thu", { defaultValue: "Thu" }) },
    { value: "5", label: t("scheduleEditor.day.fri", { defaultValue: "Fri" }) },
    { value: "6", label: t("scheduleEditor.day.sat", { defaultValue: "Sat" }) },
    { value: "0", label: t("scheduleEditor.day.sun", { defaultValue: "Sun" }) },
  ];
}

const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, i) => ({
  value: String(i + 1),
  label: String(i + 1),
}));

function parseCronToPreset(cron: string): {
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

  const [min, hr, dom, , dow] = parts;

  // Every minute: "* * * * *"
  if (min === "*" && hr === "*" && dom === "*" && dow === "*") {
    return { preset: "every_minute", ...defaults };
  }

  // Every hour: "0 * * * *"
  if (hr === "*" && dom === "*" && dow === "*") {
    return { preset: "every_hour", ...defaults, minute: min === "*" ? "0" : min };
  }

  // Every day: "M H * * *"
  if (dom === "*" && dow === "*" && hr !== "*") {
    return { preset: "every_day", ...defaults, hour: hr, minute: min === "*" ? "0" : min };
  }

  // Weekdays: "M H * * 1-5"
  if (dom === "*" && dow === "1-5" && hr !== "*") {
    return { preset: "weekdays", ...defaults, hour: hr, minute: min === "*" ? "0" : min };
  }

  // Weekly: "M H * * D" (single day)
  if (dom === "*" && /^\d$/.test(dow) && hr !== "*") {
    return { preset: "weekly", ...defaults, hour: hr, minute: min === "*" ? "0" : min, dayOfWeek: dow };
  }

  // Monthly: "M H D * *"
  if (/^\d{1,2}$/.test(dom) && dow === "*" && hr !== "*") {
    return { preset: "monthly", ...defaults, hour: hr, minute: min === "*" ? "0" : min, dayOfMonth: dom };
  }

  return { preset: "custom", ...defaults };
}

function buildCron(preset: SchedulePreset, hour: string, minute: string, dayOfWeek: string, dayOfMonth: string): string {
  switch (preset) {
    case "every_minute":
      return "* * * * *";
    case "every_hour":
      return `${minute} * * * *`;
    case "every_day":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${dayOfWeek}`;
    case "monthly":
      return `${minute} ${hour} ${dayOfMonth} * *`;
    case "custom":
      return "";
  }
}

function describeSchedule(t: TFunction, cron: string): string {
  const { preset, hour, minute, dayOfWeek, dayOfMonth } = parseCronToPreset(cron);
  const hours = buildHours(t);
  const hourLabel = hours.find((h) => h.value === hour)?.label ?? `${hour}`;
  const timeStr = `${hourLabel.replace(/ (AM|PM)$/, "")}:${minute.padStart(2, "0")} ${hourLabel.match(/(AM|PM)$/)?.[0] ?? ""}`;

  switch (preset) {
    case "every_minute":
      return t("scheduleEditor.describe.everyMinute", { defaultValue: "Every minute" });
    case "every_hour":
      return t("scheduleEditor.describe.everyHour", {
        defaultValue: "Every hour at :{{minute}}",
        minute: minute.padStart(2, "0"),
      });
    case "every_day":
      return t("scheduleEditor.describe.everyDay", { defaultValue: "Every day at {{time}}", time: timeStr });
    case "weekdays":
      return t("scheduleEditor.describe.weekdays", { defaultValue: "Weekdays at {{time}}", time: timeStr });
    case "weekly": {
      const days = buildDaysOfWeek(t);
      const day = days.find((d) => d.value === dayOfWeek)?.label ?? dayOfWeek;
      return t("scheduleEditor.describe.weekly", {
        defaultValue: "Every {{day}} at {{time}}",
        day,
        time: timeStr,
      });
    }
    case "monthly":
      return t("scheduleEditor.describe.monthly", {
        defaultValue: "Monthly on the {{day}}{{suffix}} at {{time}}",
        day: dayOfMonth,
        suffix: ordinalSuffix(Number(dayOfMonth)),
        time: timeStr,
      });
    case "custom":
      return cron || t("scheduleEditor.describe.noSchedule", { defaultValue: "No schedule set" });
  }
}

function ordinalSuffix(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

export { describeSchedule };

export function ScheduleEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (cron: string) => void;
}) {
  const { t } = useTranslation();
  const presets = useMemo(() => buildPresets(t), [t]);
  const hours = useMemo(() => buildHours(t), [t]);
  const daysOfWeek = useMemo(() => buildDaysOfWeek(t), [t]);
  const parsed = useMemo(() => parseCronToPreset(value), [value]);
  const [preset, setPreset] = useState<SchedulePreset>(parsed.preset);
  const [hour, setHour] = useState(parsed.hour);
  const [minute, setMinute] = useState(parsed.minute);
  const [dayOfWeek, setDayOfWeek] = useState(parsed.dayOfWeek);
  const [dayOfMonth, setDayOfMonth] = useState(parsed.dayOfMonth);
  const [customCron, setCustomCron] = useState(preset === "custom" ? value : "");

  // Sync from external value changes
  useEffect(() => {
    const p = parseCronToPreset(value);
    setPreset(p.preset);
    setHour(p.hour);
    setMinute(p.minute);
    setDayOfWeek(p.dayOfWeek);
    setDayOfMonth(p.dayOfMonth);
    if (p.preset === "custom") setCustomCron(value);
  }, [value]);

  const emitChange = useCallback(
    (p: SchedulePreset, h: string, m: string, dow: string, dom: string, custom: string) => {
      if (p === "custom") {
        onChange(custom);
      } else {
        onChange(buildCron(p, h, m, dow, dom));
      }
    },
    [onChange],
  );

  const handlePresetChange = (newPreset: SchedulePreset) => {
    setPreset(newPreset);
    if (newPreset === "custom") {
      setCustomCron(value);
    } else {
      emitChange(newPreset, hour, minute, dayOfWeek, dayOfMonth, customCron);
    }
  };

  return (
    <div className="space-y-3">
      <Select value={preset} onValueChange={(v) => handlePresetChange(v as SchedulePreset)}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={t("scheduleEditor.chooseFrequency", { defaultValue: "Choose frequency..." })} />
        </SelectTrigger>
        <SelectContent>
          {presets.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {preset === "custom" ? (
        <div className="space-y-1.5">
          <Input
            value={customCron}
            onChange={(e) => {
              setCustomCron(e.target.value);
              emitChange("custom", hour, minute, dayOfWeek, dayOfMonth, e.target.value);
            }}
            placeholder="0 10 * * *"
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            {t("scheduleEditor.fiveFieldsHelp", {
              defaultValue: "Five fields: minute hour day-of-month month day-of-week",
            })}
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {preset !== "every_minute" && preset !== "every_hour" && (
            <>
              <span className="text-sm text-muted-foreground">
                {t("scheduleEditor.at", { defaultValue: "at" })}
              </span>
              <Select
                value={hour}
                onValueChange={(h) => {
                  setHour(h);
                  emitChange(preset, h, minute, dayOfWeek, dayOfMonth, customCron);
                }}
              >
                <SelectTrigger className="w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {hours.map((h) => (
                    <SelectItem key={h.value} value={h.value}>
                      {h.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-sm text-muted-foreground">:</span>
              <Select
                value={minute}
                onValueChange={(m) => {
                  setMinute(m);
                  emitChange(preset, hour, m, dayOfWeek, dayOfMonth, customCron);
                }}
              >
                <SelectTrigger className="w-[80px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MINUTES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}

          {preset === "every_hour" && (
            <>
              <span className="text-sm text-muted-foreground">
                {t("scheduleEditor.atMinute", { defaultValue: "at minute" })}
              </span>
              <Select
                value={minute}
                onValueChange={(m) => {
                  setMinute(m);
                  emitChange(preset, hour, m, dayOfWeek, dayOfMonth, customCron);
                }}
              >
                <SelectTrigger className="w-[80px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MINUTES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      :{m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}

          {preset === "weekly" && (
            <>
              <span className="text-sm text-muted-foreground">
                {t("scheduleEditor.on", { defaultValue: "on" })}
              </span>
              <div className="flex gap-1">
                {daysOfWeek.map((d) => (
                  <Button
                    key={d.value}
                    type="button"
                    variant={dayOfWeek === d.value ? "default" : "outline"}
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      setDayOfWeek(d.value);
                      emitChange(preset, hour, minute, d.value, dayOfMonth, customCron);
                    }}
                  >
                    {d.label}
                  </Button>
                ))}
              </div>
            </>
          )}

          {preset === "monthly" && (
            <>
              <span className="text-sm text-muted-foreground">
                {t("scheduleEditor.onDay", { defaultValue: "on day" })}
              </span>
              <Select
                value={dayOfMonth}
                onValueChange={(dom) => {
                  setDayOfMonth(dom);
                  emitChange(preset, hour, minute, dayOfWeek, dom, customCron);
                }}
              >
                <SelectTrigger className="w-[80px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAYS_OF_MONTH.map((d) => (
                    <SelectItem key={d.value} value={d.value}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
        </div>
      )}
    </div>
  );
}
