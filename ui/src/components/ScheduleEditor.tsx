import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";

type SchedulePreset = "every_minute" | "every_hour" | "every_day" | "weekdays" | "weekly" | "monthly" | "custom";

const PRESET_VALUES: SchedulePreset[] = [
  "every_minute", "every_hour", "every_day", "weekdays", "weekly", "monthly", "custom",
];

const HOURS = Array.from({ length: 24 }, (_, i) => ({
  value: String(i),
  label12: i === 0 ? "12" : i < 12 ? `${i}` : i === 12 ? "12" : `${i - 12}`,
  ampm: i < 12 ? "am" : "pm",
}));

const MINUTES = Array.from({ length: 12 }, (_, i) => ({
  value: String(i * 5),
  label: String(i * 5).padStart(2, "0"),
}));

const DAY_KEYS = [
  { value: "1", key: "mon" },
  { value: "2", key: "tue" },
  { value: "3", key: "wed" },
  { value: "4", key: "thu" },
  { value: "5", key: "fri" },
  { value: "6", key: "sat" },
  { value: "0", key: "sun" },
] as const;

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

function describeSchedule(cron: string): string {
  const t = i18n.t.bind(i18n);
  const { preset, hour, minute, dayOfWeek, dayOfMonth } = parseCronToPreset(cron);
  const hourEntry = HOURS.find((h) => h.value === hour);
  const ampmLabel = hourEntry ? t(`agents:schedule.amPm.${hourEntry.ampm}`) : "";
  const timeStr = `${hourEntry?.label12 ?? hour}:${minute.padStart(2, "0")} ${ampmLabel}`;

  switch (preset) {
    case "every_minute":
      return t("agents:schedule.describe.everyMinute");
    case "every_hour":
      return t("agents:schedule.describe.everyHourAt", { minute: minute.padStart(2, "0") });
    case "every_day":
      return t("agents:schedule.describe.everyDayAt", { time: timeStr });
    case "weekdays":
      return t("agents:schedule.describe.weekdaysAt", { time: timeStr });
    case "weekly": {
      const dayKey = DAY_KEYS.find((d) => d.value === dayOfWeek)?.key ?? dayOfWeek;
      const day = t(`agents:schedule.days.${dayKey}`);
      return t("agents:schedule.describe.weeklyAt", { day, time: timeStr });
    }
    case "monthly":
      return t("agents:schedule.describe.monthlyAt", { day: dayOfMonth, time: timeStr });
    case "custom":
      return cron || t("agents:schedule.describe.noSchedule");
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
  const { t } = useTranslation(["agents"]);
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
          <SelectValue placeholder={t("agents:schedule.choosePlaceholder")} />
        </SelectTrigger>
        <SelectContent>
          {PRESET_VALUES.map((p) => (
            <SelectItem key={p} value={p}>
              {t(`agents:schedule.presets.${p}`)}
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
            {t("agents:schedule.cronHelp")}
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {preset !== "every_minute" && preset !== "every_hour" && (
            <>
              <span className="text-sm text-muted-foreground">{t("agents:schedule.at")}</span>
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
                  {HOURS.map((h) => (
                    <SelectItem key={h.value} value={h.value}>
                      {h.label12} {t(`agents:schedule.amPm.${h.ampm}`)}
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
              <span className="text-sm text-muted-foreground">{t("agents:schedule.atMinute")}</span>
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
              <span className="text-sm text-muted-foreground">{t("agents:schedule.on")}</span>
              <div className="flex gap-1">
                {DAY_KEYS.map((d) => (
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
                    {t(`agents:schedule.days.${d.key}`)}
                  </Button>
                ))}
              </div>
            </>
          )}

          {preset === "monthly" && (
            <>
              <span className="text-sm text-muted-foreground">{t("agents:schedule.onDay")}</span>
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
