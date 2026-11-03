/**
 * Tiny best-effort cron → localized display helper for the routine Triggers section.
 * Not a full cron parser: it covers the common shapes Paperclip schedule triggers
 * produce (every N minutes/hours, daily at HH:MM, weekday/weekend, day-of-week).
 * Falls back to the raw expression when it can't confidently describe it.
 */

import { i18n, t } from "@/i18n";

const DOW_KEYS = ["day0", "day1", "day2", "day3", "day4", "day5", "day6"];

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function describeTime(minute: string, hour: string): string | null {
  const m = Number(minute);
  const h = Number(hour);
  if (!Number.isInteger(m) || !Number.isInteger(h)) return null;
  if (m < 0 || m > 59 || h < 0 || h > 23) return null;
  return `${pad2(h)}:${pad2(m)}`;
}

function describeDayOfWeek(dow: string): string | null {
  if (dow === "*" || dow === "?") return t("localizationSchedule.everyDayPhrase");
  if (dow === "1-5") return t("localizationSchedule.weekdayPhrase");
  if (dow === "0,6" || dow === "6,0" || dow === "0,7") return t("localizationSchedule.weekendPhrase");
  const parts = dow.split(",").map((part) => part.trim());
  const names = parts.map((part) => {
    const n = Number(part);
    if (!Number.isInteger(n)) return null;
    const key = DOW_KEYS[n % 7];
    return key ? t(`localizationSchedule.${key}`) : null;
  });
  if (names.some((name) => name === null)) return null;
  return t("localizationSchedule.daysPhrase", {
    days: new Intl.ListFormat(i18n.language, { style: "long", type: "conjunction" }).format(names as string[]),
  });
}

export function describeCron(expression: string | null | undefined): string | null {
  if (!expression) return null;
  const trimmed = expression.trim();
  const fields = trimmed.split(/\s+/);
  // Standard 5-field cron: minute hour day-of-month month day-of-week
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields;

  // Every N minutes
  const everyMinutes = minute.match(/^\*\/(\d+)$/);
  if (everyMinutes && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return t("localizationSchedule.everyMinutes", { count: Number(everyMinutes[1]) });
  }

  // Every N hours, on the minute
  const everyHours = hour.match(/^\*\/(\d+)$/);
  if (everyHours && /^\d+$/.test(minute) && dom === "*" && month === "*" && dow === "*") {
    return t("localizationSchedule.everyHoursAt", { count: Number(everyHours[1]), minute: pad2(Number(minute)) });
  }

  // Hourly
  if (/^\d+$/.test(minute) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return t("localizationSchedule.hourlyAt", { minute: pad2(Number(minute)) });
  }

  // Daily / weekly at a fixed time
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && month === "*") {
    const time = describeTime(minute, hour);
    if (!time) return null;
    if (dom === "*" && (dow === "*" || dow === "?")) {
      return t("localizationSchedule.dailyAt", { time });
    }
    if (dom === "*") {
      const dowText = describeDayOfWeek(dow);
      if (dowText) return t("localizationSchedule.daysAt", { days: `${dowText[0].toLocaleUpperCase(i18n.language)}${dowText.slice(1)}`, time });
    }
    if (/^\d+$/.test(dom) && (dow === "*" || dow === "?")) {
      return t("localizationSchedule.monthDayAt", { day: dom, time });
    }
  }

  return null;
}
