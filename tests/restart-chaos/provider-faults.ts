/**
 * Provider message faults (PV1 delay, PV2 drop, PV3 duplicate): the third fault
 * family, next to control-plane restarts (K*) and storage faults (ST*). The
 * provider stays alive; one chosen protocol message on the real path between the
 * Paperclip runner and the Codex app-server is late, missing or repeated.
 *
 * Seam: `provider-shim/codex-resolve-hook.mjs` is loaded into the wave's server
 * through NODE_OPTIONS. It answers the server's lookup of
 * `@openai/codex/package.json` (how product code finds the local Codex) with a
 * stand-in package in the instance temp root whose `codex` bin is
 * `provider-shim/codex-shim.mjs`. The shim runs the real Codex and relays its
 * stdio, applying the rule armed for the task's nonce. No product code changes,
 * so the same harness runs against older product commits.
 *
 * Claude runs through the ACPX sidecar with a hash-verified provider pack: its
 * seam is acpx-provider-faults.ts, which shares this file's rules, log and check.
 */
import { chmod, copyFile, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { K4_MIN_HOLD_MS, type OracleResult, type TaskPlan, type WaveOptions, type WorkloadId } from "./types.js";

export const PROVIDER_FAULT_KINDS = ["PV1", "PV2", "PV3"] as const;
export type ProviderFaultKind = (typeof PROVIDER_FAULT_KINDS)[number];
export const PROVIDER_FAULT_ACTIONS: Record<ProviderFaultKind, "delay" | "drop" | "duplicate"> = { PV1: "delay", PV2: "drop", PV3: "duplicate" };

/** `terminal`: the turn/completed that follows a turn/interrupt. `interrupt_ack`: the response to that turn/interrupt. */
export const PROVIDER_MESSAGES = ["terminal", "interrupt_ack"] as const;
export type ProviderMessage = (typeof PROVIDER_MESSAGES)[number];

/** Restarts a provider fault may straddle: K1 kill -9, K2 SIGTERM graceful restart, K4 kill -9 then an outage hold. */
export const PROVIDER_RESTART_KINDS = ["K1", "K2", "K4"] as const;
export type ProviderRestartKind = (typeof PROVIDER_RESTART_KINDS)[number];
/** K4 outage hold after a provider fault: the low end of the seeded K4 range. */
export const PROVIDER_FAULT_K4_HOLD_MS = K4_MIN_HOLD_MS;

/** PV1 default: the late terminal of PR #20330 (the old 15 s governed-wait drain against Codex's 30 s command window). */
export const DEFAULT_PROVIDER_DELAY_MS = 18_000;
/** Bound on a PV1 delay: beyond 10 minutes a message is effectively dropped (PV2). */
export const MAX_PROVIDER_DELAY_MS = 600_000;

export interface ProviderFaultRule {
  kind: ProviderFaultKind;
  message: ProviderMessage;
  /** PV1 only. */
  delayMs?: number;
  /**
   * `--provider-fault-restart K1|K2|K4` (PV1, PV2): restart the control plane this long after the fault
   * applied, so the held or dropped message straddles a restart. `holdMs` is the K4 outage.
   */
  restart?: { kind: ProviderRestartKind; afterAppliedMs: number; holdMs?: number };
}

/** Default gap between a provider fault applying and its restart: well inside the default 18 s PV1 hold. */
export const DEFAULT_PROVIDER_FAULT_RESTART_AFTER_MS = 3_000;

/** One shim log line (JSONL, `provider-faults.jsonl` in the wave directory). */
export interface ProviderFaultEvent {
  at: number;
  pid: number;
  event: "spawned" | "bound" | "interrupt_requested" | "applied" | "released" | "held_message_discarded" | "exited" | "spawn_failed";
  nonce?: string | null;
  kind?: ProviderFaultKind;
  message?: ProviderMessage;
  action?: "delay" | "drop" | "duplicate";
  delayMs?: number;
  turnStatus?: string | null;
  [key: string]: unknown;
}

/**
 * Workloads whose run sends turn/interrupt: a saved question (Q1) and a board Stop (S1). Not G1: its agent
 * asks for approval through `call_api` and ends its own turn, so nothing interrupts the provider and no
 * rule ever applies (waves w-20261110T050407-s206, w-20261110T063253-s208 and w-20261110T085554-s211:
 * applied=0 for Codex and Claude, and the board then waits for a restart that never comes).
 */
export const PROVIDER_FAULT_WORKLOADS: readonly WorkloadId[] = ["Q1", "S1"];

export function isProviderFault(value: string): value is ProviderFaultKind {
  return (PROVIDER_FAULT_KINDS as readonly string[]).includes(value);
}

/**
 * `--provider-fault-delays 5,14,18` (seconds) for PV1: task i gets the i-th delay, cycling, so a
 * small wave sweeps the window around a deadline.
 */
export function parseProviderDelays(raw: string | undefined): number[] | undefined {
  if (raw === undefined) return undefined;
  const values = raw.split(",").map(value => value.trim()).filter(Boolean);
  if (!values.length) throw new Error("--provider-fault-delays must not be empty");
  return values.map(value => {
    if (!/^[0-9]+(\.[0-9]+)?$/.test(value)) throw new Error(`--provider-fault-delays: "${value}" is not a number of seconds`);
    const ms = Math.round(Number(value) * 1000);
    if (ms > MAX_PROVIDER_DELAY_MS) throw new Error(`--provider-fault-delays: ${value}s exceeds ${MAX_PROVIDER_DELAY_MS / 1000}s; use PV2 to drop a message`);
    return ms;
  });
}

export function parseProviderMessage(raw: string | undefined): ProviderMessage | undefined {
  return parseProviderMessages(raw).message;
}

/**
 * `--provider-fault-message terminal` or `--provider-fault-message S1=interrupt_ack,terminal`: a bare
 * message is the wave default; `WORKLOAD=message` overrides it for that workload's tasks (Codex ends a
 * Stop without its terminal, so S1 needs `interrupt_ack` while Q1 keeps `terminal`).
 */
export function parseProviderMessages(raw: string | undefined): { message?: ProviderMessage; byWorkload?: Partial<Record<WorkloadId, ProviderMessage>> } {
  if (raw === undefined) return {};
  const result: { message?: ProviderMessage; byWorkload?: Partial<Record<WorkloadId, ProviderMessage>> } = {};
  const entries = raw.split(",").map(value => value.trim()).filter(Boolean);
  if (!entries.length) throw new Error(`--provider-fault-message must be one of ${PROVIDER_MESSAGES.join(", ")}`);
  for (const entry of entries) {
    const [left, right] = entry.includes("=") ? entry.split("=", 2) as [string, string] : [undefined, entry];
    if (!(PROVIDER_MESSAGES as readonly string[]).includes(right)) throw new Error(`--provider-fault-message must be one of ${PROVIDER_MESSAGES.join(", ")}`);
    if (left === undefined) {
      if (result.message) throw new Error("--provider-fault-message takes one default message");
      result.message = right as ProviderMessage;
    } else {
      if (!PROVIDER_FAULT_WORKLOADS.includes(left as WorkloadId)) throw new Error(`--provider-fault-message: ${left} is not one of ${PROVIDER_FAULT_WORKLOADS.join(", ")}`);
      result.byWorkload = { ...result.byWorkload, [left]: right as ProviderMessage };
    }
  }
  return result;
}

/** Attach each provider-fault task's rule. Restart-fault tasks are unchanged. */
export function withProviderFaultRules(tasks: TaskPlan[], options: Pick<WaveOptions, "providerFaultMessage" | "providerFaultDelaysMs"
  | "providerFaultRestart" | "providerFaultRestartAfterMs" | "providerFaultRestartKinds" | "providerFaultMessageByWorkload">): TaskPlan[] {
  const delays = options.providerFaultDelaysMs?.length ? options.providerFaultDelaysMs : [DEFAULT_PROVIDER_DELAY_MS];
  const restarts = options.providerFaultRestartKinds?.length ? options.providerFaultRestartKinds
    : options.providerFaultRestart ? [options.providerFaultRestart] : [];
  let pv1 = 0;
  let restarted = 0;
  return tasks.map(task => {
    if (!isProviderFault(task.fault)) return task;
    const restartKind = restarts.length && task.fault !== "PV3" ? restarts[restarted++ % restarts.length]! : null;
    const rule: ProviderFaultRule = { kind: task.fault,
      message: options.providerFaultMessageByWorkload?.[task.workload] ?? options.providerFaultMessage ?? "terminal",
      ...(task.fault === "PV1" ? { delayMs: delays[pv1++ % delays.length]! } : {}),
      ...(restartKind
        ? { restart: { kind: restartKind, afterAppliedMs: options.providerFaultRestartAfterMs ?? DEFAULT_PROVIDER_FAULT_RESTART_AFTER_MS,
          ...(restartKind === "K4" ? { holdMs: PROVIDER_FAULT_K4_HOLD_MS } : {}) } } : {}) };
    return { ...task, providerFault: rule, fireAfterMs: 0, holdMs: 0 };
  });
}

export function describeProviderFault(rule: ProviderFaultRule): string {
  return `${rule.kind} ${PROVIDER_FAULT_ACTIONS[rule.kind]} ${rule.message}${rule.delayMs !== undefined ? ` ${rule.delayMs}ms` : ""}`
    + (rule.restart ? ` +${rule.restart.kind}@${rule.restart.afterAppliedMs}ms${rule.restart.holdMs ? `/hold${rule.restart.holdMs}ms` : ""}` : "");
}

/** The Codex executable product code would resolve for this checkout (mirrors codex-command.ts). */
export function resolveRealCodex(repositoryRoot: string): { command: string; version: string; manifestPath: string } {
  const runnerRequire = createRequire(path.join(repositoryRoot, "packages/paperclip-runner/package.json"));
  let manifestPath: string;
  try {
    const bridge = runnerRequire.resolve("@agentclientprotocol/codex-acp/package.json");
    manifestPath = createRequire(bridge).resolve("@openai/codex/package.json");
  } catch {
    try {
      const adapter = runnerRequire.resolve("@paperclipai/adapter-codex-local/server");
      manifestPath = createRequire(createRequire(adapter).resolve("@agentclientprotocol/codex-acp/package.json")).resolve("@openai/codex/package.json");
    } catch {
      manifestPath = runnerRequire.resolve("@openai/codex/package.json");
    }
  }
  manifestPath = realpathSync(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: string; bin?: string | Record<string, string> };
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.codex;
  if (!bin) throw new Error(`Installed Codex at ${manifestPath} has no codex bin`);
  return { command: realpathSync(path.resolve(path.dirname(manifestPath), bin)), version: String(manifest.version ?? "0.0.0"), manifestPath };
}

export interface ProviderFaultSeam {
  /** Merge into the server environment before it starts (kept across restarts). */
  serverEnvironment: Record<string, string>;
  controlPath: string;
  logPath: string;
  /** Once-per-task markers, shared with the ACPX tap. */
  stateDirectory: string;
  realCommand: string;
  /** Arm the rules of these tasks (idempotent; replaces the armed set). */
  arm(tasks: readonly TaskPlan[]): Promise<void>;
  /** The shim's log lines for one task. */
  eventsFor(nonce: string): Promise<ProviderFaultEvent[]>;
}

const SHIM_SOURCE = path.join(import.meta.dirname, "provider-shim", "codex-shim.mjs");
export const RESOLVE_HOOK = path.join(import.meta.dirname, "provider-shim", "codex-resolve-hook.mjs");

/**
 * Install the stand-in Codex package under `root` (the instance temp root) and return the server
 * environment that routes product Codex launches through the shim.
 */
export async function installProviderFaultSeam(input: { root: string; logPath: string; realCommand: string; realVersion: string;
  /** The real `@openai/codex/package.json`: its platform package stays reachable from the stand-in. */
  realManifestPath?: string; inheritedNodeOptions?: string }): Promise<ProviderFaultSeam> {
  const base = path.join(input.root, "provider-faults");
  const packageRoot = path.join(base, "codex-package");
  const stateDirectory = path.join(base, "state");
  const controlPath = path.join(base, "control.json");
  await mkdir(path.join(packageRoot, "bin"), { recursive: true, mode: 0o700 });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  // "type": "module" makes the copied .js shim an ES module, like the real codex.js. The real
  // package's platform dependency is linked in, so product code still grants Codex's own
  // native executable to its sandbox (codexExecutableReadOnlyRoots).
  const real = input.realManifestPath ? JSON.parse(await readFile(input.realManifestPath, "utf8")) as { optionalDependencies?: Record<string, string> } : {};
  await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify({ name: "@openai/codex", version: input.realVersion,
    type: "module", bin: { codex: "bin/codex.js" }, ...(real.optionalDependencies ? { optionalDependencies: real.optionalDependencies } : {}) }, null, 2)}\n`);
  const platformPackage = `@openai/codex-${process.platform}-${process.arch}`;
  if (input.realManifestPath && real.optionalDependencies?.[platformPackage]) {
    try {
      const platformRoot = path.dirname(createRequire(input.realManifestPath).resolve(`${platformPackage}/package.json`));
      await mkdir(path.join(packageRoot, "node_modules", "@openai"), { recursive: true });
      await symlink(platformRoot, path.join(packageRoot, "node_modules", platformPackage), "dir").catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
    } catch { /* No platform package: Codex runs as a standalone executable. */ }
  }
  const shimPath = path.join(packageRoot, "bin", "codex.js");
  await copyFile(SHIM_SOURCE, shimPath);
  await chmod(shimPath, 0o755);
  await writeFile(path.join(packageRoot, "shim-config.json"), `${JSON.stringify({ realCommand: input.realCommand,
    controlPath, logPath: input.logPath, stateDirectory }, null, 2)}\n`);
  await writeFile(controlPath, `${JSON.stringify({ rules: [] })}\n`);
  await writeFile(input.logPath, "", { flag: "a", mode: 0o600 });
  const nodeOptions = [input.inheritedNodeOptions, `--import=${RESOLVE_HOOK}`].filter(Boolean).join(" ");
  return {
    serverEnvironment: { NODE_OPTIONS: nodeOptions, RESTART_CHAOS_CODEX_PACKAGE_JSON: path.join(packageRoot, "package.json") },
    controlPath, logPath: input.logPath, stateDirectory, realCommand: input.realCommand,
    async arm(tasks) {
      const rules = tasks.flatMap(task => task.providerFault ? [{ nonce: task.nonce, ...task.providerFault }] : []);
      const temporary = `${controlPath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ rules }, null, 2)}\n`);
      await rename(temporary, controlPath);
    },
    eventsFor: nonce => readProviderFaultEvents(input.logPath, nonce),
  };
}

export async function readProviderFaultEvents(logPath: string, nonce?: string): Promise<ProviderFaultEvent[]> {
  const text = await readFile(logPath, "utf8").catch(() => "");
  const events = text.split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as ProviderFaultEvent]; } catch { return []; } });
  return nonce === undefined ? events : events.filter(event => event.nonce === nonce);
}

/**
 * A provider-fault task passes only if its fault really happened: otherwise the scenario was not
 * exercised (for example the turn ended before any interrupt), and a pass would prove nothing.
 *
 * With `--provider-fault-restart` the fault must also straddle the restart: the restart started after
 * the fault applied, the held message was not released before the old control plane had stopped
 * (`restartStoppedAt`), and it was not discarded before the restart started. A K2 drains gracefully
 * between its start and its stop, so a message released in that drain reached the old process and
 * straddled nothing. A discard after the start is the restart's own cleanup stopping the provider with
 * the message still held, which is the straddle. The kill takes the held message with the runner, so a
 * PV1 task then needs no release. Whether the task itself recovered
 * is the ordinary grade (R1–R6 and its T-oracle), which this check never replaces.
 */
export function withProviderFaultCheck(oracle: OracleResult, plan: TaskPlan, events: readonly ProviderFaultEvent[],
  restartStartedAt: number | null = null, restartStoppedAt: number | null = restartStartedAt): OracleResult {
  if (!plan.providerFault) return oracle;
  const rule = plan.providerFault;
  const applied = events.filter(event => event.event === "applied" && event.kind === rule.kind && event.message === rule.message);
  const released = events.filter(event => event.event === "released" && event.kind === rule.kind);
  // A held message the provider took with it when it exited never reached the runner: that tested a
  // drop (PV2), not a late message. It stays in the detail for diagnosis but does not count.
  const discarded = events.filter(event => event.event === "held_message_discarded" && event.kind === rule.kind);
  let exercised: boolean;
  let restartDetail = "";
  if (rule.restart) {
    const appliedAt = applied[0]?.at ?? null;
    // Released before the old control plane stopped (a K2 drain included): the old process got the
    // message, so nothing straddled the restart. Discarded before the restart started: the provider
    // exited on its own first. A discard after the start is the restart's cleanup and still straddles.
    const stoppedAt = restartStoppedAt ?? restartStartedAt;
    const releasedBeforeRestart = stoppedAt !== null && released.some(event => event.at < stoppedAt);
    const discardedBeforeRestart = restartStartedAt !== null && discarded.some(event => event.at < restartStartedAt);
    exercised = applied.length === 1 && appliedAt !== null && restartStartedAt !== null && restartStartedAt >= appliedAt
      && !releasedBeforeRestart && !discardedBeforeRestart;
    restartDetail = restartStartedAt === null ? " restart=none"
      : ` restartAfterAppliedMs=${appliedAt === null ? "n/a" : restartStartedAt - appliedAt}`
        + (releasedBeforeRestart ? " releasedBeforeRestart" : "") + (discardedBeforeRestart ? " discardedBeforeRestart" : "");
  } else {
    exercised = applied.length === 1 && (rule.kind !== "PV1" || released.length === 1);
  }
  const checks = [...oracle.checks, { name: "provider_fault_applied", ok: exercised,
    detail: `${describeProviderFault(rule)}: applied=${applied.length}${rule.kind === "PV1" ? ` released=${released.length} discarded=${discarded.length}` : ""}`
      + (applied[0]?.turnStatus ? ` turnStatus=${applied[0].turnStatus}` : "") + restartDetail }];
  return { verdict: checks.every(check => check.ok) ? "pass" : "fail", checks };
}
