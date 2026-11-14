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

/**
 * Seeded freeze length for a TM task; 0 for TM3 (its time passes through aging). Draws only for TM1/TM2.
 * `tm1RangeMs` (`--tm1-hold-seconds`) replaces TM1's default range with the same single draw, so seeds keep their cells.
 */
export function timeFaultHoldMs(kind: TimeFaultKind, int: (min: number, max: number) => number,
  tm1RangeMs?: readonly [number, number]): number {
  if (kind === "TM3") return 0;
  return int(...(kind === "TM1" && tm1RangeMs ? tm1RangeMs : TIME_FREEZE_HOLD_RANGE_MS[kind]));
}

/** `--tm1-hold-seconds` bounds: long enough to matter, within the controller-outage cap. */
export const TM1_HOLD_SECONDS_RANGE: readonly [number, number] = [10, 600];

const MIN_HOURS = 1;
const MAX_HOURS = 72;

export function parseTimeFaultOptions(options: Pick<WaveOptions, "env" | "faults" | "stormMinutes" | "crashPoint">,
  rawAgeHours: string | undefined, rawTm1HoldSeconds?: string): Pick<WaveOptions, "timeAgeMs" | "tm1HoldMs"> {
  const time = options.faults.filter(isTimeFault);
  const ages = time.some(kind => kind === "TM2" || kind === "TM3");
  if (rawAgeHours !== undefined && !ages) throw new Error("--time-age-hours sets the TM2/TM3 age; add TM2 or TM3 to --faults");
  if (rawTm1HoldSeconds !== undefined && !time.includes("TM1")) throw new Error("--tm1-hold-seconds sets the TM1 stall; add TM1 to --faults");
  if (!time.length) return {};
  // TM1 stalls the control plane alone (SIGSTOP, then SIGCONT, no restart): on Daytona the remote Runner keeps
  // working while the controller's leases lapse, as in staging's 100 s event-loop stall. TM2 and TM3 age the
  // wave database and freeze local runners, so they stay local.
  if (options.env !== "local" && time.some(kind => kind !== "TM1")) {
    throw new Error("Time faults TM2 and TM3 freeze and age a local instance; run them with --env local (TM1 also runs on Daytona)");
  }
  if (options.stormMinutes) throw new Error("Time faults (TM*) are planned per task; do not combine them with --storm-minutes");
  if (options.crashPoint) throw new Error("Time faults (TM*) do not combine with --crash-point");
  if (options.faults.includes("K14")) throw new Error("Time faults (TM*) do not combine with K14; age the upgraded build in its own wave");
  const tm1 = parseTm1HoldSeconds(rawTm1HoldSeconds);
  if (!ages) return tm1;
  if (rawAgeHours === undefined) return { ...tm1, timeAgeMs: DEFAULT_TIME_AGE_HOURS * 3_600_000 };
  if (!/^[0-9]+$/.test(rawAgeHours)) throw new Error("--time-age-hours must be a whole number of hours");
  const hours = Number(rawAgeHours);
  if (hours < MIN_HOURS || hours > MAX_HOURS) throw new Error(`--time-age-hours must be between ${MIN_HOURS} and ${MAX_HOURS}`);
  return { ...tm1, timeAgeMs: hours * 3_600_000 };
}

function parseTm1HoldSeconds(raw: string | undefined): Pick<WaveOptions, "tm1HoldMs"> {
  if (raw === undefined) return {};
  const match = /^([0-9]+)(?:-([0-9]+))?$/.exec(raw.trim());
  if (!match) throw new Error("--tm1-hold-seconds takes <seconds> or <min>-<max> seconds");
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : Number(match[2]);
  const [low, high] = TM1_HOLD_SECONDS_RANGE;
  if (min < low || max > high || max < min) throw new Error(`--tm1-hold-seconds must be between ${low} and ${high} seconds, min not above max`);
  return { tm1HoldMs: [min * 1000, max * 1000] };
}
