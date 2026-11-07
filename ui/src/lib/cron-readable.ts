import { i18n, t } from "@/i18n";

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
  if (dow === "*" || dow === "?") return t("display:cron_daily");
  if (dow === "1-5") return t("display:cron_weekdays");
  if (dow === "0,6" || dow === "6,0" || dow === "0,7") return t("display:cron_weekends");
  const parts = dow.split(",").map((part) => part.trim());
  const names = parts.map((part) => {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 7) return null;
    return t(`display:cron_day_${n % 7}`);
  });
  if (names.some((name) => name === null)) return null;
  const days = names.length === 1 ? names[0] : i18n.language.startsWith("zh")
    ? names.join("、")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return t("display:cron_every_days", { days });
}

export function describeCron(expression: string | null | undefined): string | null {
  if (!expression) return null;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields;
  const everyMinutes = minute.match(/^\*\/(\d+)$/);
  if (everyMinutes && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return t("display:cron_minutes", { count: Number(everyMinutes[1]) });
  }
  const everyHours = hour.match(/^\*\/(\d+)$/);
  if (everyHours && /^\d+$/.test(minute) && dom === "*" && month === "*" && dow === "*") {
    return t("display:cron_hours", { count: Number(everyHours[1]), minute: pad2(Number(minute)) });
  }
  if (/^\d+$/.test(minute) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return t("display:cron_hourly", { minute: pad2(Number(minute)) });
  }
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && month === "*") {
    const time = describeTime(minute, hour);
    if (!time) return null;
    if (dom === "*" && (dow === "*" || dow === "?")) return t("display:cron_daily_time", { time });
    if (dom === "*") {
      const day = describeDayOfWeek(dow);
      if (day) return t("display:cron_days_time", { day: day[0].toUpperCase() + day.slice(1), time });
    }
    if (/^\d+$/.test(dom) && (dow === "*" || dow === "?")) return t("display:cron_monthly", { day: dom, time });
  }
  return null;
}
