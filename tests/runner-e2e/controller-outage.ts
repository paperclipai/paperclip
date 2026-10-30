import { lstat, rename } from "node:fs/promises";
import type { ServingArtifact } from "./upgrade-artifacts.js";
import type { ControllerRecoveryReceipt } from "./controller-recovery-observer.js";
import { setTimeout as delay } from "node:timers/promises";
import type { MatrixExecution } from "./types.js";

export interface ControllerOutage {
  signal: "SIGTERM" | "SIGKILL";
  holdMs: number;
}

export interface ControllerOutageReceipt extends ControllerOutage {
  schema: "paperclip.e2e.controller-outage/v1";
  requestId: string;
  previousPid: number;
  replacementPid?: number;
  startedAt: string;
  stoppedAfterMs?: number;
  cacheDiscarded?: boolean;
  replacementStartedAfterMs?: number;
  readyAfterMs?: number;
  previousArtifact?: ServingArtifact;
  replacementArtifact?: ServingArtifact;
  recovery?: ControllerRecoveryReceipt;
  recoveryProgress?: Partial<ControllerRecoveryReceipt>;
}

export function parseControllerOutage(value: unknown): ControllerOutage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid controller outage");
  const { signal, holdMs } = value as Record<string, unknown>;
  if ((signal !== "SIGTERM" && signal !== "SIGKILL") || !Number.isSafeInteger(holdMs)
    || Number(holdMs) < 0 || Number(holdMs) > 300_000) throw new Error("Controller outage requires SIGTERM/SIGKILL and 0..300000 integer milliseconds");
  return { signal, holdMs: Number(holdMs) };
}

export function configuredControllerOutage(env: NodeJS.ProcessEnv, defaultHoldMs = 1_000): ControllerOutage {
  const raw = env.PAPERCLIP_RUNNER_E2E_CONTROLLER_OUTAGE_MS ?? String(defaultHoldMs);
  if (!/^\d+$/.test(raw)) throw new Error("Invalid PAPERCLIP_RUNNER_E2E_CONTROLLER_OUTAGE_MS");
  return parseControllerOutage({ signal: env.PAPERCLIP_RUNNER_E2E_CONTROLLER_STOP_SIGNAL ?? "SIGKILL", holdMs: Number(raw) });
}

export function controllerOutageForExecution(execution: MatrixExecution, env: NodeJS.ProcessEnv): ControllerOutage | undefined {
  if (execution.task.flow !== "everyday_workflow" || execution.task.id !== "recover-controller"
    || execution.environment.id !== "daytona" || execution.profile.generation !== "native"
    || (execution.profile.provider !== "codex" && execution.profile.provider !== "acpx")) return undefined;
  const declaredHoldMs = execution.suite.definitionMetadata?.controllerDowntimeMs;
  if (typeof declaredHoldMs !== "number") throw new Error("Controller recovery suite must declare its outage duration");
  const outage = configuredControllerOutage(env, declaredHoldMs);
  if (execution.suite.id === "daytona-restart-continuity" && outage.holdMs < declaredHoldMs) {
    throw new Error("Controller outage is shorter than the dedicated continuity contract");
  }
  return outage;
}

/** A fault receipt is required in addition to the runner's continuity receipts. */
export function validControllerOutageReceipt(value: unknown, expected?: ControllerOutage, requestId?: string,
  expectedArtifacts?: { previous: Pick<ServingArtifact, "revision" | "treeSha256">;
    replacement: Pick<ServingArtifact, "revision" | "treeSha256"> }): value is ControllerOutageReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as ControllerOutageReceipt;
  try { parseControllerOutage(r); } catch { return false; }
  const durations = [r.stoppedAfterMs, r.replacementStartedAfterMs, r.readyAfterMs];
  return r.schema === "paperclip.e2e.controller-outage/v1"
    && typeof r.requestId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(r.requestId)
    && typeof r.startedAt === "string" && Number.isFinite(Date.parse(r.startedAt))
    && Number.isSafeInteger(r.previousPid) && r.previousPid > 0
    && Number.isSafeInteger(r.replacementPid) && Number(r.replacementPid) > 0 && r.previousPid !== r.replacementPid
    && r.cacheDiscarded === true
    && durations.every(ms => typeof ms === "number" && Number.isFinite(ms) && ms >= 0)
    && r.replacementStartedAfterMs! - r.stoppedAfterMs! >= r.holdMs
    && r.readyAfterMs! >= r.replacementStartedAfterMs!
    && r.readyAfterMs! < 420_000
    && ((!r.previousArtifact && !r.replacementArtifact) || Boolean(r.previousArtifact && r.replacementArtifact
      && [r.previousArtifact, r.replacementArtifact].every(a => /^[a-f0-9]{40}$/.test(a.revision)
        && /^[a-f0-9]{64}$/.test(a.treeSha256) && typeof a.version === "string"
        && ["released", "development-build"].includes(a.evidence))
      && r.previousArtifact.revision !== r.replacementArtifact.revision
      && r.previousArtifact.treeSha256 !== r.replacementArtifact.treeSha256))
    && (!expectedArtifacts || Boolean(r.previousArtifact && r.replacementArtifact
      && r.previousArtifact.revision === expectedArtifacts.previous.revision
      && r.previousArtifact.treeSha256 === expectedArtifacts.previous.treeSha256
      && r.replacementArtifact.revision === expectedArtifacts.replacement.revision
      && r.replacementArtifact.treeSha256 === expectedArtifacts.replacement.treeSha256))
    && (requestId === undefined || r.requestId === requestId)
    && (!expected || (r.signal === expected.signal && r.holdMs === expected.holdMs));
}

/** Test harness only. Owners supply process cleanup, HTTP probing and cache paths.
 * No database mutation, runner command or production recovery hook is involved.
 */
export async function replaceController<T extends { pid?: number }>(input: {
  requestId: string; previousPid: number; outage: ControllerOutage;
  stop: (signal: ControllerOutage["signal"]) => Promise<void>;
  waitForUnhealthy: () => Promise<void>;
  discardCache: () => Promise<void>;
  start: () => Promise<T>;
  waitForReady: (replacement: T) => Promise<void>;
  cancelled: () => boolean;
  record: (receipt: ControllerOutageReceipt) => Promise<void>;
  previousArtifact?: ServingArtifact;
  replacementArtifact?: () => ServingArtifact | undefined;
  afterStopped?: (receipt: ControllerOutageReceipt) => Promise<void>;
  afterReady?: (receipt: ControllerOutageReceipt, record: () => Promise<void>) => Promise<void>;
}): Promise<ControllerOutageReceipt> {
  const outage = parseControllerOutage(input.outage);
  const started = performance.now();
  const receipt: ControllerOutageReceipt = { schema: "paperclip.e2e.controller-outage/v1",
    requestId: input.requestId, previousPid: input.previousPid, startedAt: new Date().toISOString(), ...outage,
    ...(input.previousArtifact ? { previousArtifact: input.previousArtifact } : {}) };
  const check = () => { if (input.cancelled()) throw new Error("Wrapper shutdown interrupted the controller outage"); };
  const record = () => input.record({ ...receipt });
  check();
  await record(); // Failed attempts retain the boundary they actually reached.
  await input.stop(outage.signal);
  await input.waitForUnhealthy();
  receipt.stoppedAfterMs = performance.now() - started;
  await input.afterStopped?.(receipt);
  await record();
  await input.discardCache();
  receipt.cacheDiscarded = true;
  await record();
  while (performance.now() - started - receipt.stoppedAfterMs < outage.holdMs) {
    check();
    await delay(Math.min(100, outage.holdMs - (performance.now() - started - receipt.stoppedAfterMs)));
  }
  check();
  receipt.replacementStartedAfterMs = performance.now() - started;
  await record();
  const replacement = await input.start();
  receipt.replacementPid = replacement.pid;
  await record();
  await input.waitForReady(replacement);
  check();
  receipt.readyAfterMs = performance.now() - started;
  if (input.previousArtifact) {
    receipt.replacementArtifact = input.replacementArtifact?.();
    if (!receipt.replacementArtifact) throw new Error("Replacement has no verified serving artifact");
  }
  await record();
  if (!validControllerOutageReceipt(receipt, outage, input.requestId)) throw new Error("Controller outage did not produce a qualifying replacement receipt");
  await input.afterReady?.(receipt, record);
  return receipt;
}

/** Retire only the controller-owned cache; this is not Runner state. */
export async function retireControllerCache(cache: string, retired: string): Promise<void> {
  try { await rename(cache, retired); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // ENOENT can also mean the destination parent is missing. Only absence of
    // the old cache satisfies retirement; preserve every other failure.
    try { await lstat(cache); }
    catch (missing) {
      if ((missing as NodeJS.ErrnoException).code === "ENOENT") return;
      throw missing;
    }
    throw error;
  }
}
