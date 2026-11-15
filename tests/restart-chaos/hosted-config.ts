import { parseArgs } from "node:util";
import { hostedTarget, type HostedTarget } from "./hosted-guard.js";
import { parseRange, parseRatio } from "./staging-mix.js";
import type { AdapterId } from "./types.js";

export type HostedMode = "run" | "observe" | "cleanup";

export interface HostedOptions {
  mode: HostedMode;
  target: HostedTarget;
  label: string;
  companyId: string | null;
  environmentId: string | null;
  releases: number;
  concurrency: number;
  tasks: number | null;
  turnMinutes: [number, number];
  ratio: Array<[AdapterId, number]>;
  subtaskShare: number;
  followUpShare: number;
  settleMs: number;
  drainMs: number;
  maxWaitMs: number;
  healthMs: number;
  seed: number;
  keep: boolean;
  retryDuringWave: boolean;
  quietMs: number;
}

export const HOSTED_FLAGS = ["hosted-base-url", "hosted-allow", "hosted-cleanup-only", "hosted-observe-only"] as const;

export function isHostedCommand(argv: readonly string[]): boolean {
  return argv.some(arg => HOSTED_FLAGS.some(flag => arg === `--${flag}` || arg.startsWith(`--${flag}=`)));
}

const LABEL = /^[a-z0-9][a-z0-9-]{2,40}$/;

function whole(raw: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`--${name} must be a whole number`);
  const value = Number(raw);
  if (value < min || value > max) throw new Error(`--${name} must be between ${min} and ${max}`);
  return value;
}

export function defaultHostedLabel(now = new Date()): string {
  return `rc-hosted-${now.toISOString().slice(0, 16).replace(/[-:T]/g, "").toLowerCase()}`;
}

export function parseHostedCommand(argv: readonly string[], now = new Date()): HostedOptions {
  const { values } = parseArgs({
    args: argv[0] === "--" ? argv.slice(1) : [...argv],
    strict: true,
    options: {
      "hosted-base-url": { type: "string" },
      "hosted-allow": { type: "string" },
      "hosted-cleanup-only": { type: "boolean" },
      "hosted-observe-only": { type: "boolean" },
      "hosted-label": { type: "string" },
      "hosted-company": { type: "string" },
      "hosted-environment": { type: "string" },
      "hosted-releases": { type: "string" },
      "hosted-concurrency": { type: "string" },
      "hosted-tasks": { type: "string" },
      "hosted-turn-minutes": { type: "string" },
      "hosted-ratio": { type: "string" },
      "hosted-subtask-share": { type: "string" },
      "hosted-follow-up-share": { type: "string" },
      "hosted-settle-minutes": { type: "string" },
      "hosted-drain-minutes": { type: "string" },
      "hosted-max-hours": { type: "string" },
      "hosted-health-seconds": { type: "string" },
      "hosted-keep": { type: "boolean" },
      "hosted-retry-during-wave": { type: "boolean" },
      "hosted-quiet-seconds": { type: "string" },
      seed: { type: "string" },
    },
  });
  const target = hostedTarget(values["hosted-base-url"], values["hosted-allow"]);
  if (values["hosted-cleanup-only"] && values["hosted-observe-only"]) throw new Error("--hosted-cleanup-only and --hosted-observe-only exclude each other");
  const mode: HostedMode = values["hosted-cleanup-only"] ? "cleanup" : values["hosted-observe-only"] ? "observe" : "run";
  if (mode === "cleanup" && !values["hosted-label"]) throw new Error("--hosted-cleanup-only needs --hosted-label <the run's label>");
  const label = values["hosted-label"] ?? defaultHostedLabel(now);
  if (!LABEL.test(label)) throw new Error("--hosted-label takes 3–41 lowercase letters, digits and dashes");
  const turnMinutes = parseRange(values["hosted-turn-minutes"] ?? "5-15", "hosted-turn-minutes", 1, 60);
  if (mode === "run" && values["hosted-releases"] === "0" && values["hosted-tasks"] === undefined) throw new Error("--hosted-releases 0 runs a fixed batch; add --hosted-tasks <n>");
  const settleMs = whole(values["hosted-settle-minutes"], "hosted-settle-minutes", 15, 1, 60) * 60_000;
  return {
    mode, target, label,
    companyId: values["hosted-company"] ?? null,
    environmentId: values["hosted-environment"] ?? null,
    releases: whole(values["hosted-releases"], "hosted-releases", mode === "observe" ? 1 : 3, 0, 20),
    concurrency: whole(values["hosted-concurrency"], "hosted-concurrency", 5, 1, 30),
    tasks: values["hosted-tasks"] === undefined ? null : whole(values["hosted-tasks"], "hosted-tasks", 1, 1, 2_000),
    turnMinutes,
    ratio: parseRatio(values["hosted-ratio"] ?? "opencode=100"),
    subtaskShare: whole(values["hosted-subtask-share"], "hosted-subtask-share", 30, 0, 100),
    followUpShare: whole(values["hosted-follow-up-share"], "hosted-follow-up-share", 50, 0, 100),
    settleMs,
    drainMs: whole(values["hosted-drain-minutes"], "hosted-drain-minutes", Math.round(turnMinutes[1] * 1.5 + 20 + settleMs / 60_000), 1, 480) * 60_000,
    maxWaitMs: whole(values["hosted-max-hours"], "hosted-max-hours", 8, 1, 24) * 3_600_000,
    healthMs: whole(values["hosted-health-seconds"], "hosted-health-seconds", 2, 1, 30) * 1_000,
    seed: whole(values.seed, "seed", Number(now.getTime() % 100_000), 0, 2 ** 31 - 1),
    keep: values["hosted-keep"] === true,
    retryDuringWave: values["hosted-retry-during-wave"] === true,
    quietMs: whole(values["hosted-quiet-seconds"], "hosted-quiet-seconds", 90, 0, 1_800) * 1_000,
  };
}
