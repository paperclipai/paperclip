/** Test-owned routing/process fault. Recovery stays entirely in production code. */
import type { MatrixExecution } from "./types.js";
import type { ControllerOutageReceipt } from "./controller-outage.js";

export const ROLLING_WEB_DEPLOYMENT_SUITE = "rolling-web-deployment";
export const isRollingWebDeployment = (execution: Pick<MatrixExecution, "suite">) => execution.suite.id === ROLLING_WEB_DEPLOYMENT_SUITE;

export interface ControllerRollingDeploymentReceipt extends Omit<ControllerOutageReceipt, "schema" | "holdMs" | "signal"> {
  schema: "paperclip.e2e.controller-rolling-deployment/v1";
  signal: "SIGTERM";
  gracefulShutdown?: boolean;
  trafficSwitchedAfterMs?: number;
  homeDeletedAfterMs?: number;
  previousHomeRemoved?: boolean;
  probes?: { reads: number; writes: number; verifiedWrites: number; failures: string[] };
}

export function validControllerRollingDeploymentReceipt(value: unknown, requestId?: string): value is ControllerRollingDeploymentReceipt {
  if (!value || typeof value !== "object") return false;
  const r = value as ControllerRollingDeploymentReceipt;
  const times = [r.replacementStartedAfterMs, r.readyAfterMs, r.trafficSwitchedAfterMs, r.stoppedAfterMs, r.homeDeletedAfterMs];
  return r.schema === "paperclip.e2e.controller-rolling-deployment/v1" && r.signal === "SIGTERM"
    && /^[A-Za-z0-9._:-]{1,200}$/.test(r.requestId) && (requestId === undefined || r.requestId === requestId)
    && Number.isFinite(Date.parse(r.startedAt))
    && Number.isSafeInteger(r.previousPid) && r.previousPid > 0
    && Number.isSafeInteger(r.replacementPid) && r.replacementPid! > 0 && r.previousPid !== r.replacementPid
    && r.cacheDiscarded === true && r.previousHomeRemoved === true && r.gracefulShutdown === true
    && times.every(ms => typeof ms === "number" && Number.isFinite(ms) && ms >= 0)
    && r.replacementStartedAfterMs! <= r.readyAfterMs! && r.readyAfterMs! <= r.trafficSwitchedAfterMs!
    && r.trafficSwitchedAfterMs! <= r.stoppedAfterMs! && r.stoppedAfterMs! <= r.homeDeletedAfterMs!
    && r.homeDeletedAfterMs! < 420_000
    && Boolean(r.probes && Number.isSafeInteger(r.probes.reads) && r.probes.reads > 0
      && Number.isSafeInteger(r.probes.writes) && r.probes.writes > 0 && r.probes.verifiedWrites === r.probes.writes
      && Array.isArray(r.probes.failures) && r.probes.failures.length === 0);
}

export async function rollController<T extends { pid?: number }>(input: {
  requestId: string; previousPid: number; start: () => Promise<T>;
  waitForReady: (replacement: T) => Promise<void>; switchTraffic: (replacement: T) => void;
  stopPrevious: () => Promise<void>; deletePreviousHome: () => Promise<void>;
  beforeHandoff?: (receipt: ControllerRollingDeploymentReceipt) => Promise<void>;
  afterPreviousStopped?: (receipt: ControllerRollingDeploymentReceipt) => Promise<void>;
  afterHandoff?: (receipt: ControllerRollingDeploymentReceipt, record: () => Promise<void>) => Promise<void>;
  cancelled: () => boolean; record: (receipt: ControllerRollingDeploymentReceipt) => Promise<void>;
}): Promise<ControllerRollingDeploymentReceipt> {
  const started = performance.now();
  const receipt: ControllerRollingDeploymentReceipt = { schema: "paperclip.e2e.controller-rolling-deployment/v1",
    requestId: input.requestId, previousPid: input.previousPid, startedAt: new Date().toISOString(), signal: "SIGTERM" };
  const elapsed = () => performance.now() - started;
  const check = () => { if (input.cancelled()) throw new Error("Wrapper shutdown interrupted the rolling deployment"); };
  const record = () => input.record({ ...receipt });
  check(); await record();
  receipt.replacementStartedAfterMs = elapsed();
  const replacement = await input.start(); receipt.replacementPid = replacement.pid; await record();
  await input.waitForReady(replacement); check(); receipt.readyAfterMs = elapsed(); await record();
  // Capture while A still owns its live lease. B may adopt immediately after
  // SIGTERM, so an observation taken after A exits would miss that boundary.
  await input.beforeHandoff?.(receipt); check();
  input.switchTraffic(replacement); receipt.trafficSwitchedAfterMs = elapsed(); await record();
  await input.stopPrevious(); receipt.gracefulShutdown = true; receipt.stoppedAfterMs = elapsed(); await record();
  await input.afterPreviousStopped?.(receipt); check(); await record();
  await input.deletePreviousHome(); receipt.homeDeletedAfterMs = elapsed();
  receipt.previousHomeRemoved = true; receipt.cacheDiscarded = true; await record();
  await input.afterHandoff?.(receipt, record);
  return receipt;
}
