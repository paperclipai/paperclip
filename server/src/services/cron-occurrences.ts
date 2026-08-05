/**
 * Expand a cron schedule into every occurrence inside a window.
 *
 * The scheduler only ever needs the *next* tick, which
 * `nextCronTickInTimeZone` (services/routines.ts) answers by stepping forward
 * one minute at a time. The calendar needs a whole month of ticks for every
 * schedule in the company at once, and minute-stepping does not survive that:
 * routines.ts:112 already records that the stepper "can block the event loop
 * for minutes per scheduler tick" (#8033), and a month of 5-minute crons is
 * ~40k minute-steps per series.
 *
 * So this module walks *civil* (timezone-local) time instead. It skips whole
 * days that the day fields reject and only materialises the
 * `hours × minutes` grid on days that match, which turns the cost from
 * "one Intl call per minute in the window" into "a few per emitted occurrence".
 *
 * It is deliberately **bug-compatible with Paperclip's own scheduler**, because
 * a calendar that disagrees with the thing it is predicting is worse than no
 * calendar:
 *
 *   - Day-of-month and day-of-week are ANDed, matching `nextCronTick`
 *     (cron.ts:280). Vixie cron ORs them; Paperclip does not, so neither does
 *     this. `0 9 13 * 5` means "the 13th, when it is a Friday".
 *   - Ambiguous civil times (the repeated hour at a DST fall-back) fire once
 *     per real instant — twice — because the scheduler's minute-stepper matches
 *     both UTC minutes that render as that wall clock.
 *   - Nonexistent civil times (the skipped hour at a DST spring-forward) never
 *     fire, because no UTC instant renders as that wall clock.
 *
 * The one place it deliberately does *not* follow the scheduler is midnight:
 * this module reads hours through `hourCycle: "h23"`, so `0 0 * * *` projects
 * correctly. The scheduler's own formatter renders midnight as hour `24` and
 * therefore never fires those routines — that is issue #7529, with a fix in
 * flight as #7922. Fixing it is not this change's job; a `0 0 * * *` routine
 * will appear on the calendar and, until #7922 lands, not run.
 *
 * @module
 */

import { parseCron, type ParsedCron } from "./cron.js";

/** A civil (timezone-local) wall-clock reading, to the minute. */
interface CivilParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export interface CronOccurrenceOptions {
  /** Inclusive lower bound on the returned instants. */
  from: Date;
  /** Inclusive upper bound on the returned instants. */
  to: Date;
  /** Stop after this many occurrences. Must be >= 0. */
  limit: number;
}

export interface CronOccurrenceResult {
  /** Ascending, inside `[from, to]`, at most `limit` long. */
  occurrences: Date[];
  /** True when `limit` cut the series short before the window ended. */
  truncated: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Formatter construction costs ~1ms of ICU work and the instances are
// immutable, so they are cached per timezone — the same reasoning (and the same
// fix) as routines.ts:112 / #8033.
const civilFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getCivilFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = civilFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      // h23 rather than `hour12: false`: the latter renders midnight as "24"
      // on Node's ICU, which is exactly how #7529 slipped into the scheduler.
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    civilFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** @throws {RangeError} when `timeZone` is not a known IANA zone. */
export function assertValidTimeZone(timeZone: string): void {
  // Intl throws RangeError on an unknown zone; constructing through the cache
  // keeps the check and the later reads on one code path.
  getCivilFormatter(timeZone).format(0);
}

function civilPartsAt(timeZone: string, instantMs: number): CivilParts {
  const parts = getCivilFormatter(timeZone).formatToParts(new Date(instantMs));
  const map: Record<string, string> = {};
  for (const part of parts) map[part.type] = part.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    // Belt and braces: if an ICU build still hands back "24" for midnight,
    // fold it to 0 rather than silently dropping every midnight occurrence.
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
  };
}

/**
 * Offset of `timeZone` from UTC at `instantMs`, in milliseconds, to the minute.
 * Positive east of Greenwich.
 */
function offsetMsAt(timeZone: string, instantMs: number): number {
  const civil = civilPartsAt(timeZone, instantMs);
  const asIfUtc = Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute);
  const flooredToMinute = Math.floor(instantMs / 60_000) * 60_000;
  return asIfUtc - flooredToMinute;
}

/**
 * The distinct UTC offsets in play across one civil day.
 *
 * Probed three times — the day before, the middle, and the day after — so a DST
 * transition anywhere inside the day shows up as more than one offset. When all
 * three agree, the day has a single offset, every wall clock in it maps to
 * exactly one instant, and the per-occurrence verification below can be skipped
 * outright. That is the difference between a few `Intl` calls per *day* and a
 * few per *occurrence*, which for a minute-level schedule is most of the cost
 * of the whole projection.
 *
 * (Two transitions inside one 48-hour window would defeat the probe. No zone in
 * the IANA database has ever done that.)
 */
function dayOffsets(timeZone: string, civilDayStartAsIfUtc: number): number[] {
  return [
    ...new Set([
      offsetMsAt(timeZone, civilDayStartAsIfUtc - MS_PER_DAY),
      offsetMsAt(timeZone, civilDayStartAsIfUtc + MS_PER_DAY / 2),
      offsetMsAt(timeZone, civilDayStartAsIfUtc + 2 * MS_PER_DAY),
    ]),
  ];
}

/**
 * Every real UTC instant whose wall clock in `timeZone` reads exactly `civil`.
 *
 * Normally one. Zero inside a spring-forward gap. Two inside a fall-back fold,
 * returned earliest first — both are emitted because the scheduler's
 * minute-stepper fires on both.
 *
 * @param candidateOffsets — the offsets in play that civil day, from {@link dayOffsets}.
 */
function instantsForCivilTime(
  timeZone: string,
  civil: CivilParts,
  candidateOffsets: number[],
): number[] {
  const asIfUtc = Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute);

  // A day with one offset has no gap and no fold, so the mapping is
  // unambiguous and there is nothing to verify.
  if (candidateOffsets.length === 1) return [asIfUtc - candidateOffsets[0]!];

  const matches: number[] = [];
  for (const offset of candidateOffsets) {
    const candidate = asIfUtc - offset;
    const readsBackAs = civilPartsAt(timeZone, candidate);
    if (
      readsBackAs.year === civil.year &&
      readsBackAs.month === civil.month &&
      readsBackAs.day === civil.day &&
      readsBackAs.hour === civil.hour &&
      readsBackAs.minute === civil.minute
    ) {
      matches.push(candidate);
    }
  }
  return matches.sort((a, b) => a - b);
}

/** Day-of-week (0 = Sunday) for a civil calendar date — pure calendar maths. */
function civilWeekday(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function dayMatches(cron: ParsedCron, year: number, month: number, day: number): boolean {
  if (!cron.months.includes(month)) return false;
  // AND, not OR — see the module header.
  if (!cron.daysOfMonth.includes(day)) return false;
  return cron.daysOfWeek.includes(civilWeekday(year, month, day));
}

/**
 * Expand `expression` into its occurrences inside `[from, to]`.
 *
 * @param expression — 5-field cron expression, parsed by {@link parseCron}.
 * @param timeZone — IANA zone the expression is written in.
 * @throws {Error} on an invalid cron expression.
 * @throws {RangeError} on an unknown timezone.
 */
export function expandCronOccurrences(
  expression: string,
  timeZone: string,
  options: CronOccurrenceOptions,
): CronOccurrenceResult {
  const cron = parseCron(expression);
  assertValidTimeZone(timeZone);

  const limit = Math.max(0, Math.floor(options.limit));
  const fromMs = options.from.getTime();
  const toMs = options.to.getTime();
  if (limit === 0 || !(fromMs <= toMs)) {
    return { occurrences: [], truncated: false };
  }

  // Walk from a day before the window to a day after it: a civil date can
  // straddle the UTC bounds in either direction depending on the offset, and
  // instants are filtered exactly below anyway.
  const cursor = civilPartsAt(timeZone, fromMs - MS_PER_DAY);
  const endCivil = civilPartsAt(timeZone, toMs + MS_PER_DAY);
  const lastCivilDayNumber = Date.UTC(endCivil.year, endCivil.month - 1, endCivil.day);

  const occurrences: Date[] = [];

  // Civil dates ascend, and hours/minutes are ascending sorted arrays, so
  // emitted instants ascend too — which is what makes the early exit at `limit`
  // return the *earliest* occurrences rather than an arbitrary slice.
  let dayNumber = Date.UTC(cursor.year, cursor.month - 1, cursor.day);
  for (; dayNumber <= lastCivilDayNumber; dayNumber += MS_PER_DAY) {
    const date = new Date(dayNumber);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (!dayMatches(cron, year, month, day)) continue;

    // Hoisted out of the hour/minute loops: the offsets are a property of the
    // day, not of the wall clock inside it.
    const offsets = dayOffsets(timeZone, dayNumber);

    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        for (const instant of instantsForCivilTime(
          timeZone,
          { year, month, day, hour, minute },
          offsets,
        )) {
          if (instant < fromMs) continue;
          if (instant > toMs) return { occurrences, truncated: false };
          if (occurrences.length >= limit) return { occurrences, truncated: true };
          occurrences.push(new Date(instant));
        }
      }
    }
  }

  return { occurrences, truncated: false };
}
