import type { StormFault, StormPlan } from "./types.js";
import { MIX_MAX_MINUTES } from "./staging-mix.js";

export interface ReleaseSwapOptions {
  swaps: number;
  spacingMs: number;
  overlapMs: number;
  settleMs: number;
  drainMs?: number;
}

export const RELEASE_SWAP_DEFAULTS: ReleaseSwapOptions = { swaps: 6, spacingMs: 40 * 60_000, overlapMs: 510_000, settleMs: 15 * 60_000 };
export const RELEASE_SWAP_SHORT: ReleaseSwapOptions = { swaps: 3, spacingMs: 12 * 60_000, overlapMs: 510_000, settleMs: 15 * 60_000 };
export const RELEASE_SWAP_BOOT_ALLOWANCE_MS = 120_000;
export const RELEASE_SWAP_LATE_LEAD_MS = 20_000;

const FLAGS = {
  "release-swap-count": { key: "swaps", unit: 1, min: 1, max: 24 },
  "release-swap-spacing-minutes": { key: "spacingMs", unit: 60_000, min: 2, max: 120 },
  "release-swap-overlap-seconds": { key: "overlapMs", unit: 1_000, min: 30, max: 600 },
  "release-swap-settle-minutes": { key: "settleMs", unit: 60_000, min: 1, max: 60 },
  "release-swap-drain-minutes": { key: "drainMs", unit: 60_000, min: 1, max: 240 },
} as const;

const MIX_PLANNED = ["mix-fault-spacing-minutes", "mix-minutes"];

const REPLACED = ["storm-minutes", "faults", "k15-overlap-seconds", "k15-hold-seconds", "replay", "crash-point", "matrix", "upgrade-from"];

function flagName(arg: string): string | null {
  return arg.startsWith("--") ? arg.slice(2).split("=")[0]! : null;
}

export function expandReleaseSwapArgs(input: readonly string[]): { args: string[]; releaseSwap?: ReleaseSwapOptions } {
  const rest: string[] = [];
  const values: Partial<Record<keyof typeof FLAGS, string>> = {};
  let enabled = false;
  let short = false;
  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index]!;
    const name = flagName(arg);
    if (name === "release-swap" || name === "release-swap-short") {
      if (arg.includes("=")) throw new Error(`--${name} takes no value`);
      enabled = true;
      short ||= name === "release-swap-short";
      continue;
    }
    if (name && name in FLAGS) {
      const inline = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : undefined;
      const value = inline ?? input[index + 1];
      if (inline === undefined) index += 1;
      if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
      values[name as keyof typeof FLAGS] = value;
      continue;
    }
    rest.push(arg);
  }
  if (!enabled) {
    const stray = Object.keys(values);
    if (stray.length) throw new Error(`--${stray[0]} shapes the release swap; add --release-swap`);
    return { args: rest };
  }
  const given = new Set(rest.map(flagName).filter((name): name is string => name !== null));
  const clash = REPLACED.find(name => given.has(name));
  if (clash) throw new Error(`--release-swap plans its own K15 swaps; do not combine it with --${clash}`);
  const options: ReleaseSwapOptions = { ...(short ? RELEASE_SWAP_SHORT : RELEASE_SWAP_DEFAULTS) };
  for (const [flag, spec] of Object.entries(FLAGS) as Array<[keyof typeof FLAGS, (typeof FLAGS)[keyof typeof FLAGS]]>) {
    const raw = values[flag];
    if (raw === undefined) continue;
    if (!/^[0-9]+$/.test(raw)) throw new Error(`--${flag} must be a whole number`);
    const value = Number(raw);
    if (value < spec.min || value > spec.max) throw new Error(`--${flag} must be between ${spec.min} and ${spec.max}`);
    options[spec.key] = value * spec.unit;
  }
  if (options.spacingMs < options.overlapMs + RELEASE_SWAP_BOOT_ALLOWANCE_MS) {
    throw new Error(`--release-swap-spacing-minutes must leave the overlap plus ${RELEASE_SWAP_BOOT_ALLOWANCE_MS / 1000} s for the incoming server's boot`);
  }
  const envIndex = rest.findIndex(arg => arg === "--env" || arg.startsWith("--env="));
  const env = envIndex < 0 ? "local" : rest[envIndex]!.includes("=") ? rest[envIndex]!.split("=")[1] : rest[envIndex + 1];
  const mix = given.has("workload");
  if (mix) {
    const planned = MIX_PLANNED.find(name => given.has(name));
    if (planned) throw new Error(`--release-swap plans the staging-mix swap slots; do not combine it with --${planned}`);
  }
  const spacingMinutes = Math.ceil(options.spacingMs / 60_000);
  if (mix && options.swaps * spacingMinutes + 1 > MIX_MAX_MINUTES) {
    throw new Error(`--release-swap-count ${options.swaps} × --release-swap-spacing-minutes ${spacingMinutes} needs a ${options.swaps * spacingMinutes + 1}-minute `
      + `staging-mix wave; the longest is ${MIX_MAX_MINUTES} minutes. Lower the swap count or the spacing.`);
  }
  const clock = mix
    ? ["--mix-fault-spacing-minutes", String(spacingMinutes), "--mix-minutes", String(options.swaps * spacingMinutes + 1)]
    : ["--storm-minutes", String(Math.min(240, Math.ceil((options.swaps * options.spacingMs) / 60_000)))];
  const added = [...clock, "--faults", "K15", "--k15-overlap-seconds", String(Math.round(options.overlapMs / 1000))];
  if (env === "daytona") {
    if (!given.has("k15-fresh-home")) added.push("--k15-fresh-home");
    if (!given.has("ephemeral-server")) added.push("--ephemeral-server");
  }
  return { args: [...rest, ...added], releaseSwap: options };
}

export function planReleaseSwaps(options: ReleaseSwapOptions): StormPlan {
  const faults: StormFault[] = Array.from({ length: options.swaps }, () => ({ kind: "K15", holdMs: options.overlapMs, gapMs: options.spacingMs }));
  return { durationMs: options.swaps * options.spacingMs, faults };
}

export function swapDueAt(startedAt: number, spacingMs: number, index: number): number {
  return startedAt + (index + 1) * spacingMs;
}

export class ReleaseSwapRun {
  readonly state: { startedAt: number; fired: number; lastSettledAt: number | null };
  ended = false;
  private unsettled = false;

  constructor(readonly plan: StormPlan, startedAt: number) {
    this.state = { startedAt, fired: 0, lastSettledAt: null };
  }

  private get complete(): boolean {
    return this.state.fired >= this.plan.faults.length && !this.unsettled;
  }

  endIfDue(_now: number): boolean {
    if (this.ended || !this.complete) return false;
    this.ended = true;
    return true;
  }

  mayLaunch(_now: number): boolean {
    return !this.ended;
  }

  due(now: number): StormFault | null {
    if (this.ended || this.unsettled) return null;
    const next = this.plan.faults[this.state.fired];
    if (!next) return null;
    return now >= swapDueAt(this.state.startedAt, next.gapMs, this.state.fired) ? next : null;
  }

  commit(fault: StormFault, now: number): boolean {
    if (this.due(now) !== fault) return false;
    this.state.fired += 1;
    this.unsettled = true;
    return true;
  }

  settled(now: number) {
    this.state.lastSettledAt = now;
    this.unsettled = false;
  }

  exhaustedEarly(_now: number): boolean {
    return !this.complete;
  }
}

export const OVERLAP_LAUNCH_READY_MARGIN_MS = 30_000;

export function overlapLaunchExtensionMs(launchedAt: number, stoppedAt: number): number {
  return Math.max(0, stoppedAt - launchedAt) + OVERLAP_LAUNCH_READY_MARGIN_MS;
}
