import { execFileSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { applyJourneyOptions } from "./journey-matrix.js";
import { takesJourneyTriggers } from "./journeys.js";
import { STORAGE_FAULT_KINDS, type StorageFaultKind } from "./storage-chaos.js";
import { isMultiServerFault, validateMultiServerOptions } from "./multi-server.js";
import { parseK15DeployShape, parseK15HoldSeconds } from "./redeploy.js";
import { validateRecoveryStep } from "./recovery-step-faults.js";
import { parseLongTurnMinutes } from "./long-turn.js";
import { isRewakeWorkload } from "./rewake.js";
import { applyStagingMix, STAGING_MIX_ARG_OPTIONS } from "./staging-mix.js";
import { workloadDefinitions } from "./workloads.js";
import { parseClassROptions } from "./class-r.js";
import { parseTimeFaultOptions } from "./time-faults-config.js";
import { parseStorageTrigger } from "./storage-trigger.js";
import { parseNativeTrigger, parseNativeTriggerOutage } from "./native-trigger.js";
import { parseRepeatedRestartOptions } from "./repeated-restarts.js";
import { expandReleaseSwapArgs } from "./release-swap-schedule.js";
import { daytonaRetainsSandboxes } from "./ttft-baseline-stats.js";
import { PROVIDER_FAULT_KINDS, PROVIDER_FAULT_WORKLOADS, TOOL_COMPLETED_WORKLOADS, UNINTERRUPTED_PROVIDER_MESSAGES, isProviderFault, parseProviderDelays, parseProviderMessages, type ProviderFaultKind } from "./provider-faults.js";
import { SESSION_FAULT_KINDS, SESSION_FAULT_WORKLOADS, isSessionFault, type SessionFaultKind } from "./session-faults.js";
import { PROVIDER_FAULT_ADAPTERS, parseProviderFaultRestart } from "./acpx-provider-faults.js";
import { DISK_FULL_FAULT_KINDS, isDiskFullFault, type DiskFullFaultKind } from "./disk-full-faults.js";
import {
  ADAPTER_IDS, ENVIRONMENT_KINDS, FAULT_KINDS, TRIGGER_IDS, WORKLOAD_IDS,
  type AdapterId, type EnvironmentKind, type FaultKind, type TriggerId, type WaveOptions, type WorkloadId,
} from "./types.js";

/**
 * A storm's default faults: every restart kind except K14, which needs an older build (`--upgrade-from`),
 * and K15, which changes the deploy identity of every later server (pass `--faults` to include it).
 */
export const STORM_DEFAULT_FAULTS: FaultKind[] = ["K1", "K2", "K4", "K6"];

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
  const { args, releaseSwap } = expandReleaseSwapArgs(argv[0] === "--" ? argv.slice(1) : [...argv]);
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
      "daytona-pack-mismatch": { type: "string" },
      "daytona-cpu": { type: "string" },
      "daytona-reuse-lease": { type: "boolean" },
      // The reusable warm Daytona fixture, or an environment that inherits the lifecycle (a user's default).
      "daytona-warm": { type: "boolean" },
      "daytona-inherit": { type: "boolean" },
      keep: { type: "boolean" },
      "rc06-masked": { type: "boolean" },
      "storm-minutes": { type: "string" },
      lifecycle: { type: "string" },
      "k4-hold-max-seconds": { type: "string" },
      "fault-after-seconds": { type: "string" },
      "crash-point": { type: "string" },
      "crash-point-hold-ms": { type: "string" },
      "upgrade-from": { type: "string" },
      "workspace-repo": { type: "string" },
      storage: { type: "string" },
      "storage-faults": { type: "string" },
      "storage-fault-seconds": { type: "string" },
      "storage-trigger": { type: "string" },
      "native-trigger": { type: "string" },
      "native-trigger-outage": { type: "string" },
      "provider-fault-message": { type: "string" },
      "provider-fault-delays": { type: "string" },
      "db-pressure": { type: "string" },
      matrix: { type: "boolean" },
      "server-from": { type: "string" },
      "time-age-hours": { type: "string" },
      "provider-fault-restart": { type: "string" },
      "provider-fault-restart-after-seconds": { type: "string" },
      "rr-gap-seconds": { type: "string" },
      "rr-stop-on": { type: "string" },
      "k15-hold-seconds": { type: "string" },
      "k15-overlap-seconds": { type: "string" },
      "k15-fresh-home": { type: "boolean" },
      "ephemeral-server": { type: "boolean" },
      "runner-bind-fault": { type: "boolean" },
      "tm1-hold-seconds": { type: "string" },
      "fail-recovery-step": { type: "string" },
      "long-turn-minutes": { type: "string" },
      "sandbox-watch-seconds": { type: "string" },
      "cr1-hold-seconds": { type: "string" },
      "cr2-hold-seconds": { type: "string" },
      "cr3-stall-seconds": { type: "string" },
      ...STAGING_MIX_ARG_OPTIONS,
    },
  });
  const keep = values.keep === true;
  const pollMs = integer(values["poll-ms"], "poll-ms", 3_000, 2_000, 5_000);
  const budgetCents = integer(values["budget-cents"], "budget-cents", 3_000, 1, 100_000);
  if (values.replay !== undefined) {
    for (const key of ["env", "adapters", "workloads", "faults", "triggers", "concurrency", "tasks", "seed", "daytona-image", "daytona-pack-mismatch", "daytona-cpu", "daytona-reuse-lease", "daytona-warm", "daytona-inherit", "storm-minutes", "lifecycle", "k4-hold-max-seconds", "crash-point", "crash-point-hold-ms", "upgrade-from", "workspace-repo", "storage", "storage-faults", "storage-fault-seconds", "storage-trigger", "native-trigger", "native-trigger-outage", "fault-after-seconds", "provider-fault-message", "provider-fault-delays", "db-pressure", "matrix", "server-from", "time-age-hours", "provider-fault-restart", "provider-fault-restart-after-seconds", "rr-gap-seconds", "rr-stop-on", "k15-hold-seconds", "k15-overlap-seconds", "k15-fresh-home", "ephemeral-server", "runner-bind-fault", "tm1-hold-seconds", "fail-recovery-step", "long-turn-minutes", "cr1-hold-seconds", "cr2-hold-seconds", "cr3-stall-seconds", "sandbox-watch-seconds"] as const) {
      if (values[key] !== undefined) throw new Error(`--replay reproduces the saved plan; do not combine it with --${key}`);
    }
    for (const key of Object.keys(STAGING_MIX_ARG_OPTIONS) as Array<keyof typeof STAGING_MIX_ARG_OPTIONS>) {
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
  const daytonaSandboxImage = values["daytona-pack-mismatch"];
  if (daytonaSandboxImage !== undefined) {
    if (env !== "daytona") throw new Error("--daytona-pack-mismatch applies only to --env daytona");
    if (!/^.+@sha256:[0-9a-f]{64}$/.test(daytonaSandboxImage)) {
      throw new Error("--daytona-pack-mismatch needs an immutable image whose provider pack differs: <registry/repository@sha256:…>");
    }
    if (daytonaSandboxImage === daytonaImage) throw new Error("--daytona-pack-mismatch must name a different image than --daytona-image");
  }
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
  const adapters = list<AdapterId>(values.adapters, ADAPTER_IDS, "adapters", ["codex", "claude"]);
  // `--faults` takes restart faults (K*), provider message faults (PV*, provider-faults.ts), the
  // sandbox disk-full fault (DF1, disk-full-faults.ts), session faults (SR*, session-faults.ts) and K0, cells with no fault.
  const allFaults = list<FaultKind | ProviderFaultKind | DiskFullFaultKind | SessionFaultKind | "K0">(values.faults, [...FAULT_KINDS, ...PROVIDER_FAULT_KINDS, ...DISK_FULL_FAULT_KINDS, ...SESSION_FAULT_KINDS, "K0"], "faults",
    stormMinutes ? STORM_DEFAULT_FAULTS : crashPoint ? ["K1"] : ["K1", "K2", "K4"]);
  const providerFaults = allFaults.filter(isProviderFault);
  const diskFullFaults = allFaults.filter(isDiskFullFault);
  const sessionFaults = allFaults.filter(isSessionFault);
  const baseline = allFaults.includes("K0");
  const volumeFree = values["ephemeral-server"] === true || values["k15-fresh-home"] === true;
  const options: WaveOptions = {
    env,
    adapters,
    // The governance scenarios (G1, H1), the journeys (Q1–Q4) and the contention run (L1) are opt-in: H1 needs a wave of its own.
    workloads: list<WorkloadId>(values.workloads, workloadChoices, "workloads", workloadChoices.filter(id => !(volumeFree && workloadDefinitions[id].usesRepository) && id !== "G1" && id !== "H1" && id !== "R1" && id !== "S1" && id !== "L1" && id !== "F1" && id !== "T1" && id !== "Q4" && id !== "H2" && id !== "SM"
      && !takesJourneyTriggers(id) && !isRewakeWorkload(id) && (id !== "M1" || adapters.length >= 2))),
    // A crash-point wave schedules no fault; K1 is the restart its self-kill gets.
    faults: allFaults.filter((fault): fault is FaultKind => !isProviderFault(fault) && !isDiskFullFault(fault) && !isSessionFault(fault) && fault !== "K0"),
    ...(providerFaults.length ? { providerFaults } : {}),
    ...(diskFullFaults.length ? { diskFullFaults } : {}),
    ...(sessionFaults.length ? { sessionFaults } : {}),
    ...(baseline ? { baseline: true } : {}),
    triggers: list<TriggerId>(values.triggers, TRIGGER_IDS, "triggers", ["time"]),
    concurrency: integer(values.concurrency, "concurrency", 4, 1, 20),
    tasks: integer(values.tasks, "tasks", stormMinutes ? 200 : 8, 1, 200),
    ...(stormMinutes ? { stormMinutes } : {}),
    seed: integer(values.seed, "seed", now % 2_147_483_647, 0, 2_147_483_647),
    budgetCents,
    pollMs,
    ...(env === "daytona" ? { daytonaImage, ...(daytonaSandboxImage ? { daytonaSandboxImage } : {}), daytonaCpu: integer(values["daytona-cpu"], "daytona-cpu", DAYTONA_DEFAULT_CPU, 1, 4),
      ...(values["daytona-reuse-lease"] ? { daytonaReuseLease: true } : {}),
      ...(values["daytona-warm"] ? { daytonaWarm: true } : {}), ...(values["daytona-inherit"] ? { daytonaInherit: true } : {}) } : {}),
    ...(values["rc06-masked"] ? { masks: ["rc06"] } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    // Seeded K4 hold upper end; the controller-outage cap is 600 s (#19797).
    ...(values["k4-hold-max-seconds"] !== undefined
      ? { k4HoldMaxMs: integer(values["k4-hold-max-seconds"], "k4-hold-max-seconds", 300, 120, 600) * 1000 } : {}),
    ...(values["fault-after-seconds"] !== undefined
      ? { faultAfterMs: integer(values["fault-after-seconds"], "fault-after-seconds", 60, 5, 3_600) * 1000 } : {}),
    ...(crashPoint ? { crashPoint } : {}),
    ...(crashPoint && values["crash-point-hold-ms"] !== undefined
      ? { crashPointHoldMs: integer(values["crash-point-hold-ms"], "crash-point-hold-ms", 0, 0, 600_000) } : {}),
  };
  if (values["fault-after-seconds"] !== undefined && (stormMinutes || crashPoint)) {
    throw new Error("--fault-after-seconds sets planned fault times; a storm or crash-point wave has none");
  }
  if (values["fault-after-seconds"] !== undefined && (options.triggers ?? []).some(trigger => trigger !== "time")) {
    throw new Error("--fault-after-seconds fires faults by time; use it with --triggers time");
  }
  if (!crashPoint && values["crash-point-hold-ms"] !== undefined) throw new Error("--crash-point-hold-ms applies only to --crash-point");
  if (diskFullFaults.length) {
    if (stormMinutes) throw new Error("The disk-full fault (DF1) is planned per task; do not combine it with --storm-minutes");
    // Only a remote sandbox workspace has a save the sandbox disk can refuse; a local run has none.
    if (env !== "daytona" || values.storage !== "s3") throw new Error("The disk-full fault (DF1) needs a remote sandbox workspace save; run it with --env daytona --storage s3");
    if (providerFaults.length) throw new Error("The disk-full fault (DF1) does not share a wave with provider message faults (PV*)");
    // The matrix planner builds its cells from restart and provider faults only; DF1 would silently drop out.
    if (values.matrix) throw new Error("The disk-full fault (DF1) is not a --matrix cell; run it as a planned wave");
  }
  if (baseline && (stormMinutes || crashPoint)) throw new Error("--faults K0 plans cells with no fault; a storm or crash-point wave has its own faults");
  Object.assign(options, validateRecoveryStep(options, values["fail-recovery-step"]));
  Object.assign(options, parseLongTurnMinutes(values["long-turn-minutes"]));
  if (values["sandbox-watch-seconds"] !== undefined) {
    if (env !== "daytona") throw new Error("--sandbox-watch-seconds captures Daytona sandboxes; run it with --env daytona");
    options.sandboxWatchMs = integer(values["sandbox-watch-seconds"], "sandbox-watch-seconds", 30, 10, 600) * 1000;
  }
  // The matrix planner builds its own task plans; a long turn would silently drop out of them.
  if (options.longTurnMinutes && values.matrix) throw new Error("--long-turn-minutes is not a --matrix option; run it as a planned wave");
  if (providerFaults.length) {
    if (stormMinutes) throw new Error("Provider message faults (PV*) are planned per task; do not combine them with --storm-minutes");
    if (env !== "local") throw new Error("Provider message faults (PV*) shim the local provider; run them with --env local");
    if (adapters.some(adapter => !PROVIDER_FAULT_ADAPTERS.includes(adapter))) throw new Error(`Provider message faults (PV*) cover ${PROVIDER_FAULT_ADAPTERS.join(" and ")}; remove the other adapters from --adapters`);
    // Every PV task gets its own restart through --provider-fault-restart; a planned K cell would be a different task.
    if (options.faults.length) throw new Error("Provider message faults (PV*) do not share a wave with planned restart faults (K*); use --provider-fault-restart K1 to restart after each provider fault");
    const messages = parseProviderMessages(values["provider-fault-message"]);
    const messageFor = (id: WorkloadId) => messages.byWorkload?.[id] ?? messages.message ?? "terminal";
    const idle = options.workloads.filter(id => !(UNINTERRUPTED_PROVIDER_MESSAGES.includes(messageFor(id))
      ? TOOL_COMPLETED_WORKLOADS : PROVIDER_FAULT_WORKLOADS).includes(id));
    if (idle.length) {
      throw new Error(idle.some(id => UNINTERRUPTED_PROVIDER_MESSAGES.includes(messageFor(id)))
        ? `--provider-fault-message tool_completed needs workloads that save a document before finishing (${TOOL_COMPLETED_WORKLOADS.join(", ")}); remove ${idle.join(", ")} from --workloads`
        : `Provider message faults (PV*) need workloads that interrupt a provider turn (${PROVIDER_FAULT_WORKLOADS.join(", ")}); remove ${idle.join(", ")} from --workloads`);
    }
    if (options.workloads.some(id => UNINTERRUPTED_PROVIDER_MESSAGES.includes(messageFor(id))) && adapters.some(adapter => adapter !== "codex")) {
      throw new Error("--provider-fault-message tool_completed shims Codex only; run it with --adapters codex");
    }
    if (messages.message) options.providerFaultMessage = messages.message;
    if (messages.byWorkload) options.providerFaultMessageByWorkload = messages.byWorkload;
    const delays = parseProviderDelays(values["provider-fault-delays"]);
    if (delays && !providerFaults.includes("PV1")) throw new Error("--provider-fault-delays sets PV1 delays; add PV1 to --faults");
    if (delays) options.providerFaultDelaysMs = delays;
    Object.assign(options, parseProviderFaultRestart(values["provider-fault-restart"], values["provider-fault-restart-after-seconds"], providerFaults, delays));
    // Each K1 kills the whole control plane: a second task in flight would lose its held message to the
    // first task's restart and miss its own, so a restart wave runs one task at a time.
    if (options.providerFaultRestart && options.concurrency !== 1) throw new Error("--provider-fault-restart restarts the whole control plane per task; run it with --concurrency 1");
    // The board holds its answers until the planned restart fires, but Q4's fault lands only after the
    // first answer: the restart would wait for an answer that waits for the restart.
    if ((options.providerFaultRestart || options.providerFaultRestartKinds?.length) && options.workloads.includes("Q4")) {
      throw new Error("--provider-fault-restart does not cover Q4: its fault needs the first answer, which the board holds until the restart; run Q4 without it");
    }
  } else if (values["provider-fault-message"] !== undefined || values["provider-fault-delays"] !== undefined
    || values["provider-fault-restart"] !== undefined || values["provider-fault-restart-after-seconds"] !== undefined) {
    throw new Error("--provider-fault-message, --provider-fault-delays and --provider-fault-restart need a provider fault (PV1, PV2 or PV3) in --faults");
  }
  if (sessionFaults.length) {
    if (stormMinutes) throw new Error("Session faults (SR*) are planned per task; do not combine them with --storm-minutes");
    if (options.faults.length || providerFaults.length) throw new Error("Session faults (SR*) restart nothing; run them in a wave without K* or PV* faults");
    const other = options.workloads.filter(id => !SESSION_FAULT_WORKLOADS.includes(id));
    if (other.length) throw new Error(`Session faults (SR*) need ${SESSION_FAULT_WORKLOADS.join(", ")}; remove ${other.join(", ")} from --workloads`);
    // Only a retained warm owner can be superseded; a per-turn Runner exits after each turn.
    if (options.lifecycle !== "warm" && !options.daytonaWarm) throw new Error("Session faults (SR*) need a retained owner: add --lifecycle warm (or --daytona-warm)");
    // SR1U arms its fault for the whole server and needs a reused sandbox to drop.
    if (sessionFaults.includes("SR1U") && (env !== "daytona" || !options.daytonaWarm)) throw new Error("SR1U needs a reused sandbox: run it with --env daytona --daytona-warm");
    if (sessionFaults.includes("SR1U") && sessionFaults.includes("SR1")) throw new Error("SR1U arms its fault for every task; run SR1 in a separate wave");
  }
  validateMultiServerOptions(options);
  // K15 emulates one deploy identity per generation; a second server beside it would run in the real host's process space.
  if (options.faults.includes("K15") && options.faults.some(isMultiServerFault)) {
    throw new Error("K15 (redeploy) does not combine with MS1-MS3: the second server would not share the emulated deploy identity");
  }
  Object.assign(options, parseTimeFaultOptions(options, values["time-age-hours"], values["tm1-hold-seconds"]));
  Object.assign(options, parseRepeatedRestartOptions(options, values["rr-gap-seconds"], values["rr-stop-on"]));
  Object.assign(options, parseK15HoldSeconds(options, values["k15-hold-seconds"]));
  Object.assign(options, parseK15DeployShape(options, values["k15-overlap-seconds"], values["k15-fresh-home"] === true));
  Object.assign(options, parseClassROptions(options, { cr1: values["cr1-hold-seconds"], cr2: values["cr2-hold-seconds"], cr3: values["cr3-stall-seconds"] }));
  const upgradeFrom = values["upgrade-from"];
  if (options.faults.includes("K14") !== (upgradeFrom !== undefined)) {
    throw new Error("K14 (upgrade mid-run) and --upgrade-from <older checkout> go together: pass both or neither");
  }
  if (upgradeFrom !== undefined) {
    // The remote runner must match its Daytona image, so an older build cannot run there.
    if (env !== "local") throw new Error("--upgrade-from runs only with --env local");
    if (crashPoint) throw new Error("--upgrade-from does not combine with --crash-point");
    options.upgradeFrom = path.resolve(upgradeFrom);
  }
  applyJourneyOptions(options, { matrix: values.matrix === true, serverFrom: values["server-from"], tasksGiven: values.tasks !== undefined,
    triggersGiven: values.triggers !== undefined });
  const storage = values.storage ?? (values["k15-fresh-home"] ? "s3" : "local");
  const workspaceRepo = values["workspace-repo"];
  if (options.workloads.includes("R1") !== (workspaceRepo !== undefined)) {
    throw new Error("R1 (code change in a cloned repository) and --workspace-repo <git repository> go together: pass both or neither");
  }
  if (workspaceRepo !== undefined) {
    if (env !== "local" && storage !== "s3") throw new Error("--workspace-repo on Daytona needs --storage s3, so the clone reaches the sandbox as a remote workspace");
    if (options.workloads.some(id => id === "B1" || id === "B5")) throw new Error("--workspace-repo replaces the chaoscli fixture that B1 and B5 need");
    options.workspaceRepo = path.resolve(workspaceRepo);
    const git = (...args: string[]) => execFileSync("git", ["-C", options.workspaceRepo!, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (env === "daytona") {
      options.workspaceGitUrl = publicGitHubUrl(git("remote", "get-url", "origin"));
      options.workspaceCommit = git("rev-parse", "origin/master");
    } else {
      options.workspaceCommit = git("rev-parse", "HEAD");
    }
  }
  // H1 pauses the whole company when its budget hard stop is crossed: no other task can share its
  // wave, its tasks run one at a time, and the hard stop must be on.
  if (options.workloads.includes("H1")) {
    if (options.workloads.length !== 1) throw new Error("--workloads H1 pauses the whole company; run it in its own wave (--workloads H1)");
    if (options.concurrency !== 1) throw new Error("--workloads H1 runs one task at a time; pass --concurrency 1");
    if (options.masks?.includes("rc06")) throw new Error("--workloads H1 needs the budget hard stop; do not combine it with --rc06-masked");
    if (stormMinutes) throw new Error("--workloads H1 does not combine with --storm-minutes");
  }
  if (options.workloads.includes("M1") && options.adapters.length < 2) {
    throw new Error("--workloads M1 delegates between two agents; pass at least two --adapters");
  }
  if (env !== "daytona" && values["daytona-cpu"] !== undefined) throw new Error("--daytona-cpu applies only to --env daytona");
  if (env !== "daytona" && values["daytona-reuse-lease"]) throw new Error("--daytona-reuse-lease applies only to --env daytona");
  for (const key of ["daytona-warm", "daytona-inherit"] as const) {
    if (env !== "daytona" && values[key]) throw new Error(`--${key} applies only to --env daytona`);
  }
  if (values["daytona-warm"] && values["daytona-inherit"]) throw new Error("--daytona-warm and --daytona-inherit cannot be combined: pick the warm fixture or an inheriting environment");
  if (options.daytonaCpu !== undefined) {
    const budget = integer(process.env.RESTART_CHAOS_DAYTONA_VCPU_BUDGET, "RESTART_CHAOS_DAYTONA_VCPU_BUDGET", DAYTONA_VCPU_BUDGET, 1, 1_000);
    // A warm sandbox outlives its task for the idle window, and a new task cannot reuse
    // another task's sandbox, so with --daytona-warm (or --daytona-inherit with a warm
    // agent lifecycle) every task can hold one at once.
    const retains = daytonaRetainsSandboxes({ warmEnvironment: options.daytonaWarm === true,
      inheritEnvironment: options.daytonaInherit === true, lifecycle: options.lifecycle });
    const holders = retains ? Math.max(options.concurrency, options.tasks) : options.concurrency;
    if (holders * options.daytonaCpu > budget) {
      if (retains) throw new Error(`${options.daytonaWarm ? "--daytona-warm" : `--daytona-inherit with --lifecycle ${options.lifecycle}`} keeps each task's sandbox for the idle window: ${holders} tasks × `
        + `--daytona-cpu ${options.daytonaCpu} vCPU exceeds the Daytona vCPU budget of ${budget}. Lower --tasks or --daytona-cpu `
        + "(RESTART_CHAOS_DAYTONA_VCPU_BUDGET sets the budget).");
      throw new Error(`--concurrency ${options.concurrency} × --daytona-cpu ${options.daytonaCpu} vCPU exceeds the Daytona vCPU budget of ${budget} `
        + "for chaos tasks. Lower one of them (RESTART_CHAOS_DAYTONA_VCPU_BUDGET sets the budget).");
    }
  }
  if (values["db-pressure"] !== undefined) options.dbPressure = integer(values["db-pressure"], "db-pressure", 0, 1, 8);
  if (storage !== "local" && storage !== "s3") throw new Error("--storage must be local or s3");
  if (storage === "s3") options.storage = "s3";
  if (values["ephemeral-server"] || options.k15FreshHome) {
    const flag = values["ephemeral-server"] ? "--ephemeral-server" : "--k15-fresh-home (a volume-free deploy)";
    if (storage !== "s3") throw new Error(`${flag} runs volume-free and needs shared object storage: pass --storage s3`);
    if (env !== "daytona") throw new Error(`${flag} runs only with --env daytona: a local workspace blocks a volume-free server`);
    if (options.faults.includes("K14")) throw new Error(`${flag} does not combine with K14 (--upgrade-from)`);
    const repository = options.workloads.filter(workload => workloadDefinitions[workload].usesRepository);
    if (repository.length) throw new Error(`${flag} cannot run ${repository.join(", ")}: the fixture repository is a local_path project source, which a volume-free server refuses; pick other --workloads`);
    options.ephemeralServer = true;
  }
  if (values["runner-bind-fault"]) {
    if (env !== "daytona") throw new Error("--runner-bind-fault holds a port inside a remote sandbox: run it with --env daytona");
    options.runnerBindFault = true;
  }
  if (values["storage-faults"] !== undefined) {
    if (storage !== "s3") throw new Error("--storage-faults needs --storage s3");
    options.storageFaults = list<StorageFaultKind>(values["storage-faults"], STORAGE_FAULT_KINDS, "storage-faults", []);
  }
  if (values["storage-fault-seconds"] !== undefined) {
    if (!options.storageFaults?.length) throw new Error("--storage-fault-seconds needs --storage-faults");
    const match = /^(\d+)-(\d+)$/.exec(values["storage-fault-seconds"]);
    const [min, max] = match ? [Number(match[1]), Number(match[2])] : [0, -1];
    if (!match || min < 5 || max < min || max > 900) throw new Error("--storage-fault-seconds takes <min>-<max> seconds, 5 to 900, min not above max");
    options.storageFaultMs = [min * 1000, max * 1000];
  }
  if (values["storage-trigger"] !== undefined) options.storageTrigger = parseStorageTrigger(values["storage-trigger"], options);
  if (values["native-trigger"] !== undefined) options.nativeTrigger = parseNativeTrigger(values["native-trigger"], options);
  if (values["native-trigger-outage"] !== undefined) options.nativeTrigger = { ...options.nativeTrigger!, outageMs: parseNativeTriggerOutage(values["native-trigger-outage"], options) };
  if (releaseSwap) options.releaseSwap = releaseSwap;
  return { mode: "wave", options: applyStagingMix(options, values), keep };
}

export function publicGitHubUrl(remote: string): string {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (!match) throw new Error(`--workspace-repo on Daytona needs a GitHub origin the sandbox can clone over https; origin is ${remote}`);
  return `https://github.com/${match[1]}.git`;
}

export function waveIdFor(seed: number, at = new Date()): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
  return `w-${stamp}-s${seed}`;
}

export function replayCommand(waveId: string, taskId: string): string {
  return `node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --replay ${waveId}/${taskId}`;
}
