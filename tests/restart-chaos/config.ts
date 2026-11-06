import { parseArgs } from "node:util";
import {
  ADAPTER_IDS, ENVIRONMENT_KINDS, FAULT_KINDS, WORKLOAD_IDS,
  type AdapterId, type EnvironmentKind, type FaultKind, type WaveOptions, type WorkloadId,
} from "./types.js";

export const CREDENTIAL_FOR_ADAPTER: Record<AdapterId, "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | "OPENROUTER_API_KEY"> = {
  codex: "OPENAI_API_KEY",
  claude: "ANTHROPIC_API_KEY",
  opencode: "OPENROUTER_API_KEY",
};

/** Catalog profile reused from tests/runner-e2e/catalog.ts for each adapter. */
export const PROFILE_FOR_ADAPTER: Record<AdapterId, string> = {
  codex: "runner-codex",
  claude: "runner-acpx-claude",
  opencode: "runner-opencode",
};

export type ParsedCommand =
  | { mode: "wave"; options: WaveOptions; keep: boolean }
  | { mode: "replay"; ref: ReplayRef; keep: boolean; overrides: Partial<Pick<WaveOptions, "pollMs" | "budgetCents">> };

export interface ReplayRef { waveId: string; taskId: string }

const WAVE_ID = /^w-[0-9]{8}T[0-9]{6}-s[0-9]+(?:-replay-t[0-9]{2,3}-[0-9]+)?$/;
const TASK_ID = /^t[0-9]{2,3}$/;

export function parseReplayRef(value: string): ReplayRef {
  const trimmed = value.trim().replace(/\/+$/, "");
  const parts = trimmed.split("/");
  if (parts.length !== 2) throw new Error(`--replay expects <wave>/<task>, got "${value}"`);
  const [waveId, taskId] = parts as [string, string];
  if (!WAVE_ID.test(waveId)) throw new Error(`Invalid wave id "${waveId}"`);
  if (!TASK_ID.test(taskId)) throw new Error(`Invalid task id "${taskId}"`);
  return { waveId, taskId };
}

function list<T extends string>(raw: string | undefined, allowed: readonly T[], name: string, fallback: readonly T[]): T[] {
  if (raw === undefined) return [...fallback];
  const values = raw.split(",").map(value => value.trim()).filter(Boolean);
  if (!values.length) throw new Error(`--${name} must not be empty`);
  for (const value of values) if (!allowed.includes(value as T)) throw new Error(`Unknown ${name} "${value}"; allowed: ${allowed.join(", ")}`);
  return [...new Set(values)] as T[];
}

function integer(raw: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`--${name} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`--${name} must be between ${min} and ${max}`);
  return value;
}

export function parseCommand(argv: readonly string[], now = Date.now()): ParsedCommand {
  // Tolerate a forwarded literal `--` (for example from a package runner).
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      env: { type: "string" },
      adapters: { type: "string" },
      workloads: { type: "string" },
      faults: { type: "string" },
      concurrency: { type: "string" },
      tasks: { type: "string" },
      seed: { type: "string" },
      "budget-cents": { type: "string" },
      "poll-ms": { type: "string" },
      replay: { type: "string" },
      keep: { type: "boolean" },
    },
  });
  const keep = values.keep === true;
  const pollMs = integer(values["poll-ms"], "poll-ms", 3_000, 2_000, 5_000);
  const budgetCents = integer(values["budget-cents"], "budget-cents", 3_000, 1, 100_000);
  if (values.replay !== undefined) {
    for (const key of ["env", "adapters", "workloads", "faults", "concurrency", "tasks", "seed"] as const) {
      if (values[key] !== undefined) throw new Error(`--replay reproduces the saved plan; do not combine it with --${key}`);
    }
    return { mode: "replay", ref: parseReplayRef(values.replay), keep,
      overrides: { ...(values["poll-ms"] ? { pollMs } : {}), ...(values["budget-cents"] ? { budgetCents } : {}) } };
  }
  const env = (values.env ?? "local") as EnvironmentKind;
  if (!ENVIRONMENT_KINDS.includes(env)) throw new Error(`Unknown env "${env}"; allowed: ${ENVIRONMENT_KINDS.join(", ")}`);
  const options: WaveOptions = {
    env,
    adapters: list<AdapterId>(values.adapters, ADAPTER_IDS, "adapters", ["codex", "claude"]),
    workloads: list<WorkloadId>(values.workloads, WORKLOAD_IDS, "workloads", WORKLOAD_IDS),
    faults: list<FaultKind>(values.faults, FAULT_KINDS, "faults", ["K1", "K2", "K4"]),
    concurrency: integer(values.concurrency, "concurrency", 4, 1, 20),
    tasks: integer(values.tasks, "tasks", 8, 1, 200),
    seed: integer(values.seed, "seed", now % 2_147_483_647, 0, 2_147_483_647),
    budgetCents,
    pollMs,
  };
  return { mode: "wave", options, keep };
}

export function waveIdFor(seed: number, at = new Date()): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
  return `w-${stamp}-s${seed}`;
}

export function replayCommand(waveId: string, taskId: string): string {
  return `node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --replay ${waveId}/${taskId}`;
}
