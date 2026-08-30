/**
 * Client-side "next N schedule fires" helper for the routine Delivery preview (§3.5).
 *
 * Mirrors the server's timezone-aware cron tick (server/src/services/routines.ts
 * `nextCronTickInTimeZone`) closely enough for an illustrative preview: it parses
 * the same 5-field cron grammar and walks minute-by-minute, matching the cron
 * fields against wall-clock parts in the trigger's timezone via `Intl.DateTimeFormat`.
 *
 * This is preview-only — the authoritative `nextRunAt` is still computed server-side.
 */

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

interface ParsedCron {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  daysOfMonthWildcard: boolean;
  daysOfWeekWildcard: boolean;
}

interface FieldSpec {
  min: number;
  max: number;
}

const FIELD_SPECS: FieldSpec[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week (Sun = 0)
];

function parseField(token: string, spec: FieldSpec): number[] {
  const values = new Set<number>();
  for (const rawPart of token.split(",")) {
    const part = rawPart.trim();
    if (part === "") throw new Error("Empty cron field element");

    const slashIdx = part.indexOf("/");
    if (slashIdx !== -1) {
      const base = part.slice(0, slashIdx);
      const step = Number.parseInt(part.slice(slashIdx + 1), 10);
      if (!Number.isInteger(step) || step <= 0) throw new Error("Invalid cron step");
      let start = spec.min;
      let end = spec.max;
      if (base === "*") {
        // every `step` from min
      } else if (base.includes("-")) {
        const [a, b] = base.split("-").map((s) => Number.parseInt(s, 10));
        if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error("Invalid cron range");
        start = a;
        end = b;
      } else {
        const s = Number.parseInt(base, 10);
        if (!Number.isInteger(s)) throw new Error("Invalid cron start");
        start = s;
      }
      assertBounds(start, spec);
      assertBounds(end, spec);
      for (let i = start; i <= end; i += step) values.add(i);
      continue;
    }

    if (part.includes("-")) {
      const [a, b] = part.split("-").map((s) => Number.parseInt(s, 10));
      if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error("Invalid cron range");
      assertBounds(a, spec);
      assertBounds(b, spec);
      if (a > b) throw new Error("Invalid cron range (start > end)");
      for (let i = a; i <= b; i++) values.add(i);
      continue;
    }

    if (part === "*" || part === "?") {
      for (let i = spec.min; i <= spec.max; i++) values.add(i);
      continue;
    }

    const val = Number.parseInt(part, 10);
    if (!Number.isInteger(val)) throw new Error("Invalid cron value");
    assertBounds(val, spec);
    values.add(val);
  }
  if (values.size === 0) throw new Error("Empty cron field");
  return [...values].sort((a, b) => a - b);
}

function assertBounds(value: number, spec: FieldSpec): void {
  if (value < spec.min || value > spec.max) {
    throw new Error(`Cron value ${value} out of range`);
  }
}

function coversEntireField(values: number[], spec: FieldSpec): boolean {
  return values.length === spec.max - spec.min + 1 && values[0] === spec.min && values.at(-1) === spec.max;
}

/** Parse a 5-field cron expression. Returns null when it can't be parsed. */
export function parseCronExpression(expression: string | null | undefined): ParsedCron | null {
  if (!expression) return null;
  const tokens = expression.trim().split(/\s+/);
  if (tokens.length !== 5) return null;
  try {
    const daysOfMonth = parseField(tokens[2]!, FIELD_SPECS[2]!);
    const daysOfWeek = parseField(tokens[4]!, FIELD_SPECS[4]!);
    return {
      minutes: parseField(tokens[0]!, FIELD_SPECS[0]!),
      hours: parseField(tokens[1]!, FIELD_SPECS[1]!),
      daysOfMonth,
      months: parseField(tokens[3]!, FIELD_SPECS[3]!),
      daysOfWeek,
      daysOfMonthWildcard: coversEntireField(daysOfMonth, FIELD_SPECS[2]!),
      daysOfWeekWildcard: coversEntireField(daysOfWeek, FIELD_SPECS[4]!),
    };
  } catch {
    return null;
  }
}

interface ZonedParts {
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

function getZonedMinuteParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  const weekday = WEEKDAY_INDEX[map.weekday ?? ""];
  if (weekday === undefined) throw new Error(`Unable to resolve weekday for ${timeZone}`);
  return {
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday,
  };
}

function matches(cron: ParsedCron, parts: ZonedParts): boolean {
  const dayOfMonthMatches = cron.daysOfMonth.includes(parts.day);
  const dayOfWeekMatches = cron.daysOfWeek.includes(parts.weekday);
  const dayMatches =
    !cron.daysOfMonthWildcard && !cron.daysOfWeekWildcard
      ? dayOfMonthMatches || dayOfWeekMatches
      : dayOfMonthMatches && dayOfWeekMatches;

  return (
    cron.minutes.includes(parts.minute) &&
    cron.hours.includes(parts.hour) &&
    cron.months.includes(parts.month) &&
    dayMatches
  );
}

/**
 * Compute up to `count` upcoming fire instants for a cron expression, strictly
 * after `after`, interpreting the cron fields in `timeZone`.
 */
export function nextCronFires(
  expression: string | null | undefined,
  count: number,
  options: { after?: Date; timeZone?: string } = {},
): Date[] {
  const cron = parseCronExpression(expression);
  if (!cron || count <= 0) return [];
  const timeZone = options.timeZone ?? "UTC";
  const after = options.after ?? new Date();

  const cursor = new Date(after.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  const fires: Date[] = [];
  // Preview-only bound: cap sparse or impossible schedules before they can stall the UI.
  const maxIterations = 2 * 366 * 24 * 60;
  for (let i = 0; i < maxIterations && fires.length < count; i++) {
    let parts: ZonedParts;
    try {
      parts = getZonedMinuteParts(cursor, timeZone);
    } catch {
      return fires;
    }
    if (matches(cron, parts)) fires.push(new Date(cursor.getTime()));
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return fires;
}

export type FireDisposition = "queued" | "coalesced" | "skipped";

export interface FirePreviewEntry {
  at: Date;
  disposition: FireDisposition;
  /** Short human label for the disposition (e.g. "queued", "would be coalesced"). */
  label: string;
  note: string | null;
}

const DISPOSITION_LABEL: Record<FireDisposition, string> = {
  queued: "queued",
  coalesced: "would be coalesced",
  skipped: "would be skipped",
};

/**
 * Annotate a list of upcoming fires with how the chosen concurrency policy would
 * treat each, assuming the previous run is still in flight when the next fires —
 * the worst case that makes the policy's behaviour legible (§3.5).
 *
 * Pure + deterministic so it can be unit-tested without a clock.
 */
export function previewFirePolicies(
  fires: Date[],
  concurrencyPolicy: string,
): FirePreviewEntry[] {
  return fires.map((at, index) => {
    if (index === 0) {
      return {
        at,
        disposition: "queued",
        label: DISPOSITION_LABEL.queued,
        note: "runs immediately",
      };
    }
    let disposition: FireDisposition;
    switch (concurrencyPolicy) {
      case "always_enqueue":
        disposition = "queued";
        break;
      case "skip_if_active":
        disposition = "skipped";
        break;
      case "coalesce_if_active":
      default:
        disposition = "coalesced";
        break;
    }
    return {
      at,
      disposition,
      label: DISPOSITION_LABEL[disposition],
      note: disposition === "queued" ? null : "if the previous run is still active",
    };
  });
}
