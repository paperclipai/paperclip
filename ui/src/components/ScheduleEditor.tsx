import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Select, Input, ListBox } from "@heroui/react";
import { ChevronDown, ChevronRight } from "lucide-react";

type SchedulePreset = "every_minute" | "every_hour" | "every_day" | "weekdays" | "weekly" | "monthly" | "custom";

const PRESETS: { value: SchedulePreset; label: string }[] = [
  { value: "every_minute", label: "Every minute" },
  { value: "every_hour", label: "Every hour" },
  { value: "every_day", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "custom", label: "Custom (cron)" },
];

const HOURS = Array.from({ length: 24 }, (_, i) => ({
  value: String(i),
  label: i === 0 ? "12 AM" : i < 12 ? `${i} AM` : i === 12 ? "12 PM" : `${i - 12} PM`,
}));

const MINUTES = Array.from({ length: 12 }, (_, i) => ({
  value: String(i * 5),
  label: String(i * 5).padStart(2, "0"),
}));

const DAYS_OF_WEEK = [
  { value: "1", label: "Mon" },
  { value: "2", label: "Tue" },
  { value: "3", label: "Wed" },
  { value: "4", label: "Thu" },
  { value: "5", label: "Fri" },
  { value: "6", label: "Sat" },
  { value: "0", label: "Sun" },
];

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
  const { preset, hour, minute, dayOfWeek, dayOfMonth } = parseCronToPreset(cron);
  const hourLabel = HOURS.find((h) => h.value === hour)?.label ?? `${hour}`;
  const timeStr = `${hourLabel.replace(/ (AM|PM)$/, "")}:${minute.padStart(2, "0")} ${hourLabel.match(/(AM|PM)$/)?.[0] ?? ""}`;

  switch (preset) {
    case "every_minute":
      return "Every minute";
    case "every_hour":
      return `Every hour at :${minute.padStart(2, "0")}`;
    case "every_day":
      return `Every day at ${timeStr}`;
    case "weekdays":
      return `Weekdays at ${timeStr}`;
    case "weekly": {
      const day = DAYS_OF_WEEK.find((d) => d.value === dayOfWeek)?.label ?? dayOfWeek;
      return `Every ${day} at ${timeStr}`;
    }
    case "monthly":
      return `Monthly on the ${dayOfMonth}${ordinalSuffix(Number(dayOfMonth))} at ${timeStr}`;
    case "custom":
      return cron || "No schedule set";
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
      <Select
        selectedKey={preset}
        onSelectionChange={(key) => handlePresetChange(key as SchedulePreset)}
        className="w-full"
      >
        <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
        <Select.Popover placement="bottom" className="max-h-60 overflow-y-auto">
          <ListBox>
            {PRESETS.map((p) => (
              <ListBox.Item key={p.value} id={p.value}>
                {p.label}
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
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
            Five fields: minute hour day-of-month month day-of-week
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {preset !== "every_minute" && preset !== "every_hour" && (
            <>
              <span className="text-sm text-muted-foreground">at</span>
              <Select
                selectedKey={hour}
                onSelectionChange={(h) => {
                  setHour(h as string);
                  emitChange(preset, h as string, minute, dayOfWeek, dayOfMonth, customCron);
                }}
                className="w-[120px]"
              >
                <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                <Select.Popover placement="bottom" className="max-h-60 overflow-y-auto">
                  <ListBox>
                    {HOURS.map((h) => (
                      <ListBox.Item key={h.value} id={h.value}>
                        {h.label}
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
              <span className="text-sm text-muted-foreground">:</span>
              <Select
                selectedKey={minute}
                onSelectionChange={(m) => {
                  setMinute(m as string);
                  emitChange(preset, hour, m as string, dayOfWeek, dayOfMonth, customCron);
                }}
                className="w-[80px]"
              >
                <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                <Select.Popover placement="bottom" className="max-h-60 overflow-y-auto">
                  <ListBox>
                    {MINUTES.map((m) => (
                      <ListBox.Item key={m.value} id={m.value}>
                        {m.label}
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            </>
          )}

          {preset === "every_hour" && (
            <>
              <span className="text-sm text-muted-foreground">at minute</span>
              <Select
                selectedKey={minute}
                onSelectionChange={(m) => {
                  setMinute(m as string);
                  emitChange(preset, hour, m as string, dayOfWeek, dayOfMonth, customCron);
                }}
                className="w-[80px]"
              >
                <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                <Select.Popover placement="bottom" className="max-h-60 overflow-y-auto">
                  <ListBox>
                    {MINUTES.map((m) => (
                      <ListBox.Item key={m.value} id={m.value}>
                        :{m.label}
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            </>
          )}

          {preset === "weekly" && (
            <>
              <span className="text-sm text-muted-foreground">on</span>
              <div className="flex gap-1">
                {DAYS_OF_WEEK.map((d) => (
                  <Button
                    key={d.value}
                    type="button"
                    variant={dayOfWeek === d.value ? "primary" : "outline"}
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onPress={() => {
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
              <span className="text-sm text-muted-foreground">on day</span>
              <Select
                selectedKey={dayOfMonth}
                onSelectionChange={(dom) => {
                  setDayOfMonth(dom as string);
                  emitChange(preset, hour, minute, dayOfWeek, dom as string, customCron);
                }}
                className="w-[80px]"
              >
                <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                <Select.Popover placement="bottom" className="max-h-60 overflow-y-auto">
                  <ListBox>
                    {DAYS_OF_MONTH.map((d) => (
                      <ListBox.Item key={d.value} id={d.value}>
                        {d.label}
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            </>
          )}
        </div>
      )}
    </div>
  );
}
