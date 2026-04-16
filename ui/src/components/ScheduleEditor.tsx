import { useCallback, useEffect, useMemo, useState } from "react";
import { createTranslator } from "@paperclipai/shared/i18n";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { useLocale } from "../context/LocaleContext";
import { getCurrentLocale } from "../lib/locale-store";

type SchedulePreset = "every_minute" | "every_hour" | "every_day" | "weekdays" | "weekly" | "monthly" | "custom";
type Translate = ReturnType<typeof createTranslator>["t"];

const MINUTES = Array.from({ length: 12 }, (_, i) => ({
  value: String(i * 5),
  label: String(i * 5).padStart(2, "0"),
}));

const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, i) => ({
  value: String(i + 1),
  label: String(i + 1),
}));

function defaultTranslate() {
  return createTranslator(getCurrentLocale()).t;
}

function formatScheduleTime(locale: string, hour: string, minute: string) {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(2024, 0, 1, Number(hour), Number(minute), 0));
}

function formatScheduleWeekday(locale: string, dayOfWeek: string) {
  const dayNumber = dayOfWeek === "0" ? 7 : Number(dayOfWeek);
  return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(
    new Date(2024, 0, dayNumber),
  );
}

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

function describeSchedule(
  cron: string,
  t: Translate = defaultTranslate(),
  locale = getCurrentLocale(),
): string {
  const { preset, hour, minute, dayOfWeek, dayOfMonth } = parseCronToPreset(cron);
  const timeStr = formatScheduleTime(locale, hour, minute);

  switch (preset) {
    case "every_minute":
      return t("scheduleEditor.everyMinute");
    case "every_hour":
      return t("scheduleEditor.summaryEveryHourAtMinute", { minute: minute.padStart(2, "0") });
    case "every_day":
      return t("scheduleEditor.summaryEveryDayAtTime", { time: timeStr });
    case "weekdays":
      return t("scheduleEditor.summaryWeekdaysAtTime", { time: timeStr });
    case "weekly": {
      const day = formatScheduleWeekday(locale, dayOfWeek);
      return t("scheduleEditor.summaryWeeklyAtTime", { day, time: timeStr });
    }
    case "monthly":
      return t("scheduleEditor.summaryMonthlyAtTime", { day: dayOfMonth, time: timeStr });
    case "custom":
      return cron || t("scheduleEditor.noScheduleSet");
  }
}

export { describeSchedule };

export function ScheduleEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (cron: string) => void;
}) {
  const { locale, t } = useLocale();
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

  const presets = useMemo<{ value: SchedulePreset; label: string }[]>(
    () => [
      { value: "every_minute", label: t("scheduleEditor.everyMinute") },
      { value: "every_hour", label: t("scheduleEditor.everyHour") },
      { value: "every_day", label: t("scheduleEditor.everyDay") },
      { value: "weekdays", label: t("scheduleEditor.weekdays") },
      { value: "weekly", label: t("scheduleEditor.weekly") },
      { value: "monthly", label: t("scheduleEditor.monthly") },
      { value: "custom", label: t("scheduleEditor.customCron") },
    ],
    [t],
  );

  const hours = useMemo(
    () =>
      Array.from({ length: 24 }, (_, i) => ({
        value: String(i),
        label: new Intl.DateTimeFormat(locale, {
          hour: "numeric",
        }).format(new Date(2024, 0, 1, i, 0, 0)),
      })),
    [locale],
  );

  const daysOfWeek = useMemo(
    () => [
      { value: "1", label: new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(2024, 0, 1)) },
      { value: "2", label: new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(2024, 0, 2)) },
      { value: "3", label: new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(2024, 0, 3)) },
      { value: "4", label: new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(2024, 0, 4)) },
      { value: "5", label: new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(2024, 0, 5)) },
      { value: "6", label: new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(2024, 0, 6)) },
      { value: "0", label: new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(2024, 0, 7)) },
    ],
    [locale],
  );

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
          <SelectValue placeholder={t("scheduleEditor.chooseFrequency")} />
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
            placeholder={t("scheduleEditor.cronPlaceholder")}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            {t("scheduleEditor.cronHelp")}
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {preset !== "every_minute" && preset !== "every_hour" && (
            <>
              <span className="text-sm text-muted-foreground">{t("scheduleEditor.at")}</span>
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
              <span className="text-sm text-muted-foreground">{t("scheduleEditor.atMinute")}</span>
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
              <span className="text-sm text-muted-foreground">{t("scheduleEditor.on")}</span>
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
              <span className="text-sm text-muted-foreground">{t("scheduleEditor.onDay")}</span>
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
