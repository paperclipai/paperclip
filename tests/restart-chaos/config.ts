import { parseArgs } from "node:util";
import {
  ADAPTER_IDS, ENVIRONMENT_KINDS, FAULT_KINDS, TRIGGER_IDS, WORKLOAD_IDS,
  type AdapterId, type EnvironmentKind, type FaultKind, type TriggerId, type WaveOptions, type WorkloadId,
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

/**
 * Chaos sandboxes run in the company Daytona org next to the live Cloud fleet.
 * They use the runner-e2e fixture's 4 vCPU by default, and task sandboxes may
 * use at most 40 vCPU in total, a small fraction of the fleet's capacity. Set
 * RESTART_CHAOS_DAYTONA_VCPU_BUDGET lower for a smaller org (a 10 vCPU org
 * fails creates with HTTP 400 "Total CPU limit exceeded"; use 8 there so
 * verification probes still fit).
 */
export const DAYTONA_DEFAULT_CPU = 4;
export const DAYTONA_VCPU_BUDGET = 40;

export type ParsedCommand =
  | { mode: "wave"; options: WaveOptions; keep: boolean }
  | { mode: "replay"; ref: ReplayRef; keep: boolean; overrides: Partial<Pick<WaveOptions, "pollMs" | "budgetCents" | "masks">> };

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
      triggers: { type: "string" },
      concurrency: { type: "string" },
      tasks: { type: "string" },
      seed: { type: "string" },
      "budget-cents": { type: "string" },
      "poll-ms": { type: "string" },
      replay: { type: "string" },
      "daytona-image": { type: "string" },
      "daytona-cpu": { type: "string" },
      keep: { type: "boolean" },
      "rc06-masked": { type: "boolean" },
      "storm-minutes": { type: "string" },
      lifecycle: { type: "string" },
      "k4-hold-max-seconds": { type: "string" },
      "crash-point": { type: "string" },
    },
  });
  const keep = values.keep === true;
  const pollMs = integer(values["poll-ms"], "poll-ms", 3_000, 2_000, 5_000);
  const budgetCents = integer(values["budget-cents"], "budget-cents", 3_000, 1, 100_000);
  if (values.replay !== undefined) {
    for (const key of ["env", "adapters", "workloads", "faults", "triggers", "concurrency", "tasks", "seed", "daytona-image", "daytona-cpu", "storm-minutes", "lifecycle", "k4-hold-max-seconds", "crash-point"] as const) {
      if (values[key] !== undefined) throw new Error(`--replay reproduces the saved plan; do not combine it with --${key}`);
    }
    return { mode: "replay", ref: parseReplayRef(values.replay), keep,
      overrides: { ...(values["poll-ms"] ? { pollMs } : {}), ...(values["budget-cents"] ? { budgetCents } : {}),
        // The saved plan already carries its masks; this adds the RC-06 mask to a replay of an unmasked wave.
        ...(values["rc06-masked"] ? { masks: ["rc06"] } : {}) } };
  }
  const env = (values.env ?? "local") as EnvironmentKind;
  if (!ENVIRONMENT_KINDS.includes(env)) throw new Error(`Unknown env "${env}"; allowed: ${ENVIRONMENT_KINDS.join(", ")}`);
  const daytonaImage = values["daytona-image"] ?? (env === "daytona" ? process.env.PAPERCLIP_E2E_DAYTONA_IMAGE : undefined);
  if (env === "daytona" && !/^.+@sha256:[0-9a-f]{64}$/.test(daytonaImage ?? "")) {
    throw new Error("--env daytona needs an immutable runner image: --daytona-image <registry/repository@sha256:…> or PAPERCLIP_E2E_DAYTONA_IMAGE");
  }
  if (env !== "daytona" && values["daytona-image"] !== undefined) throw new Error("--daytona-image applies only to --env daytona");
  // B5 grades bench.sh progress read from the live workspace while it runs. A
  // Daytona run's live workspace is inside the sandbox, so B5 is local-only.
  const workloadChoices = env === "daytona" ? WORKLOAD_IDS.filter(id => id !== "B5") : WORKLOAD_IDS;
  // K13 restart storm: faults come from the storm clock, and `--tasks` is the
  // pool that keeps `--concurrency` tasks in flight until the storm ends.
  const stormMinutes = values["storm-minutes"] === undefined ? undefined : integer(values["storm-minutes"], "storm-minutes", 60, 1, 240);
  const lifecycle = values.lifecycle;
  const crashPoint = values["crash-point"]?.trim();
  if (crashPoint !== undefined) {
    if (!/^[a-z0-9_.]+(?::[1-9][0-9]*)?(?:,[a-z0-9_.]+(?::[1-9][0-9]*)?)*$/.test(crashPoint)) {
      throw new Error("--crash-point expects <name>[:<nth>][,<name>[:<nth>]...]");
    }
    for (const key of ["faults", "triggers", "storm-minutes"] as const) {
      if (values[key] !== undefined) throw new Error(`--crash-point replaces scheduled faults; do not combine it with --${key}`);
    }
  }
  if (lifecycle !== undefined && lifecycle !== "per_turn" && lifecycle !== "warm" && lifecycle !== "default") throw new Error("--lifecycle must be per_turn, warm or default");
  const options: WaveOptions = {
    env,
    adapters: list<AdapterId>(values.adapters, ADAPTER_IDS, "adapters", ["codex", "claude"]),
    workloads: list<WorkloadId>(values.workloads, workloadChoices, "workloads", workloadChoices),
    // A crash-point wave schedules no fault; K1 is the restart its self-kill gets.
    faults: list<FaultKind>(values.faults, FAULT_KINDS, "faults", stormMinutes ? FAULT_KINDS : crashPoint ? ["K1"] : ["K1", "K2", "K4"]),
    triggers: list<TriggerId>(values.triggers, TRIGGER_IDS, "triggers", ["time"]),
    concurrency: integer(values.concurrency, "concurrency", 4, 1, 20),
    tasks: integer(values.tasks, "tasks", stormMinutes ? 200 : 8, 1, 200),
    ...(stormMinutes ? { stormMinutes } : {}),
    seed: integer(values.seed, "seed", now % 2_147_483_647, 0, 2_147_483_647),
    budgetCents,
    pollMs,
    ...(env === "daytona" ? { daytonaImage, daytonaCpu: integer(values["daytona-cpu"], "daytona-cpu", DAYTONA_DEFAULT_CPU, 1, 4) } : {}),
    ...(values["rc06-masked"] ? { masks: ["rc06"] } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    // Seeded K4 hold upper end; the controller-outage cap is 600 s (#19797).
    ...(values["k4-hold-max-seconds"] !== undefined
      ? { k4HoldMaxMs: integer(values["k4-hold-max-seconds"], "k4-hold-max-seconds", 300, 120, 600) * 1000 } : {}),
    ...(crashPoint ? { crashPoint } : {}),
  };
  if (env !== "daytona" && values["daytona-cpu"] !== undefined) throw new Error("--daytona-cpu applies only to --env daytona");
  if (options.daytonaCpu !== undefined) {
    const budget = integer(process.env.RESTART_CHAOS_DAYTONA_VCPU_BUDGET, "RESTART_CHAOS_DAYTONA_VCPU_BUDGET", DAYTONA_VCPU_BUDGET, 1, 1_000);
    if (options.concurrency * options.daytonaCpu > budget) {
      throw new Error(`--concurrency ${options.concurrency} × --daytona-cpu ${options.daytonaCpu} vCPU exceeds the Daytona vCPU budget of ${budget} `
        + "for chaos tasks. Lower one of them (RESTART_CHAOS_DAYTONA_VCPU_BUDGET sets the budget).");
    }
  }
  return { mode: "wave", options, keep };
}

export function waveIdFor(seed: number, at = new Date()): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
  return `w-${stamp}-s${seed}`;
}

export function replayCommand(waveId: string, taskId: string): string {
  return `node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --replay ${waveId}/${taskId}`;
}
