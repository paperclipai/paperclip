/** TM planning and `--time-age-hours` validation, kept apart from time-faults.ts so the parser and scheduler load no database code. */
import type { WaveOptions } from "./types.js";

export const DEFAULT_TIME_AGE_HOURS = 26;
export const TIME_FAULT_KINDS = ["TM1", "TM2", "TM3"] as const;
export type TimeFaultKind = (typeof TIME_FAULT_KINDS)[number];

export function isTimeFault(kind: string): kind is TimeFaultKind {
  return (TIME_FAULT_KINDS as readonly string[]).includes(kind);
}

/** How long each freeze lasts. TM1 outlasts the 90 s controller lease; TM2's time passes through aging. */
export const TIME_FREEZE_HOLD_RANGE_MS: Record<"TM1" | "TM2", readonly [number, number]> = {
  TM1: [95_000, 150_000],
  TM2: [20_000, 45_000],
};

/** Default age: past a day, so hourly, daily and 1 h deadlines all lapse. `--time-age-hours` sets it (1–72). */
export const DEFAULT_TIME_AGE_MS = DEFAULT_TIME_AGE_HOURS * 3_600_000;

/** Seeded freeze length for a TM task; 0 for TM3 (its time passes through aging). Draws only for TM1/TM2. */
export function timeFaultHoldMs(kind: TimeFaultKind, int: (min: number, max: number) => number): number {
  return kind === "TM3" ? 0 : int(...TIME_FREEZE_HOLD_RANGE_MS[kind]);
}

const MIN_HOURS = 1;
const MAX_HOURS = 72;

export function parseTimeFaultOptions(options: Pick<WaveOptions, "env" | "faults" | "stormMinutes" | "crashPoint">,
  rawAgeHours: string | undefined): Pick<WaveOptions, "timeAgeMs"> {
  const time = options.faults.filter(isTimeFault);
  const ages = time.some(kind => kind === "TM2" || kind === "TM3");
  if (rawAgeHours !== undefined && !ages) throw new Error("--time-age-hours sets the TM2/TM3 age; add TM2 or TM3 to --faults");
  if (!time.length) return {};
  // A freeze sends SIGSTOP to processes under the local server; a remote runner is not one of them.
  if (options.env !== "local") throw new Error("Time faults (TM*) freeze and age a local instance; run them with --env local");
  if (options.stormMinutes) throw new Error("Time faults (TM*) are planned per task; do not combine them with --storm-minutes");
  if (options.crashPoint) throw new Error("Time faults (TM*) do not combine with --crash-point");
  if (options.faults.includes("K14")) throw new Error("Time faults (TM*) do not combine with K14; age the upgraded build in its own wave");
  if (!ages) return {};
  if (rawAgeHours === undefined) return { timeAgeMs: DEFAULT_TIME_AGE_HOURS * 3_600_000 };
  if (!/^[0-9]+$/.test(rawAgeHours)) throw new Error("--time-age-hours must be a whole number of hours");
  const hours = Number(rawAgeHours);
  if (hours < MIN_HOURS || hours > MAX_HOURS) throw new Error(`--time-age-hours must be between ${MIN_HOURS} and ${MAX_HOURS}`);
  return { timeAgeMs: hours * 3_600_000 };
}
