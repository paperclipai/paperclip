import type { heartbeatRuns } from "@paperclipai/db";

type Run = Pick<typeof heartbeatRuns.$inferSelect, "status" | "startedAt" | "finishedAt" | "runtimeMode" | "errorCode" | "error" | "resultJson">;
const SOURCES = ["operator", "queued_message", "shutdown", "provider", "transport", "control_plane", "controller_lease", "unknown"] as const;
export type CancellationSource = typeof SOURCES[number];
export interface RunCancellation {
  source: CancellationSource;
  expected: boolean;
  initiator: { type: "user" | "agent" | "system" | "provider"; id?: string };
  reason: string;
  recordedAt: string;
}

/** Server-owned local evidence. Sentry receives only the closed labels below. */
export function readRunCancellation(result: Run["resultJson"] | undefined): RunCancellation | null {
  const value = result?.cancellation;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const initiator = entry.initiator as Record<string, unknown> | undefined;
  if (!SOURCES.includes(entry.source as CancellationSource) || typeof entry.expected !== "boolean" ||
      !initiator || !["user", "agent", "system", "provider"].includes(initiator.type as string) ||
      typeof entry.reason !== "string" || typeof entry.recordedAt !== "string") return null;
  return { source: entry.source as CancellationSource, expected: entry.expected,
    initiator: { type: initiator.type as RunCancellation["initiator"]["type"],
      ...(typeof initiator.id === "string" ? { id: initiator.id } : {}) },
    reason: entry.reason.slice(0, 512), recordedAt: entry.recordedAt };
}

export function requestedRunCancellation(result: Run["resultJson"], reason: string): RunCancellation {
  const queued = typeof result?.queuedCommentInterruptQueueId === "string";
  const actorType = result?.cancelledByActorType ?? result?.interruptedByActorType;
  const user = actorType === "user" || actorType === "board" || typeof result?.cancelledByUserId === "string";
  const agent = actorType === "agent";
  const actorId = result?.cancelledByUserId ?? result?.cancelledByAgentId ?? result?.interruptedByActorId;
  const source: CancellationSource = queued ? "queued_message" : user ? "operator" : "control_plane";
  return { source, expected: true, initiator: {
    type: user ? "user" : agent ? "agent" : "system",
    ...(typeof actorId === "string" ? { id: actorId } : {}),
  }, reason: reason.slice(0, 512), recordedAt: new Date().toISOString() };
}

const LEGACY_CONTROLLER_LEASE_LOSS_CAUSES = ["renewal_rejected", "renewal_deadline", "renewal_error"] as const;
export type LegacyControllerLeaseLossCause = typeof LEGACY_CONTROLLER_LEASE_LOSS_CAUSES[number];
const controllerLeaseLossReason = (cause: LegacyControllerLeaseLossCause) => `Legacy controller lease lost (${cause})`;

/** The host aborted its own adapter after losing durable run ownership. */
export function controllerLeaseLossCancellation(cause: LegacyControllerLeaseLossCause): RunCancellation {
  return { source: "controller_lease", expected: false, initiator: { type: "system" },
    reason: controllerLeaseLossReason(cause), recordedAt: new Date().toISOString() };
}

/** Closed cause label for diagnostics; only the server-written reason matches. */
export function readControllerLeaseLossCause(cancellation: RunCancellation): LegacyControllerLeaseLossCause | null {
  if (cancellation.source !== "controller_lease") return null;
  return LEGACY_CONTROLLER_LEASE_LOSS_CAUSES.find(cause => cancellation.reason === controllerLeaseLossReason(cause)) ?? null;
}

/** Watchdog timings at the moment the lease was lost, in milliseconds. */
export interface LegacyControllerLeaseLossTiming {
  sinceRenewalMs: number;
  renewalPendingMs: number | null;
  deadlineLateMs: number | null;
  renewalCount: number;
}
/** Read-side record: a `null` timing is dropped, so every present timing is a number. */
export type LegacyControllerLeaseLoss = { cause: LegacyControllerLeaseLossCause }
  & Partial<Record<keyof LegacyControllerLeaseLossTiming, number>>;

const MAX_LEASE_LOSS_TIMING = 86_400_000;
const leaseLossTimingValue = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.round(value), MAX_LEASE_LOSS_TIMING) : undefined;

/** Closed cause and bounded counters only; unknown keys and values are dropped. */
export function readControllerLeaseLoss(value: unknown): LegacyControllerLeaseLoss | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const cause = LEGACY_CONTROLLER_LEASE_LOSS_CAUSES.find(label => label === record.cause);
  if (!cause) return null;
  const loss: LegacyControllerLeaseLoss = { cause };
  for (const field of ["sinceRenewalMs", "renewalPendingMs", "deadlineLateMs", "renewalCount"] as const) {
    const timing = leaseLossTimingValue(record[field]);
    if (timing !== undefined) loss[field] = timing;
  }
  return loss;
}

/** Preserve recorded stop intent when adapter completion replaces resultJson. */
export function cancellationResultJson(run: Run, status: string, patch?: Run["resultJson"], errorCode?: string | null, error?: string | null): Run["resultJson"] {
  if (status !== "cancelled" && status !== "interrupted") return patch ?? run.resultJson;
  const result = { ...run.resultJson, ...patch };
  const previous = readRunCancellation(run.resultJson);
  let cancellation = previous?.expected ? previous : readRunCancellation(patch) ?? previous;
  const code = errorCode ?? run.errorCode;
  if (!cancellation) {
    if (code === "server_shutdown_interrupted") {
      cancellation = { source: "shutdown", expected: true, initiator: { type: "system" },
        reason: "Server shutdown interrupted execution", recordedAt: new Date().toISOString() };
    } else if (result.cancelledByActorType || result.cancelledByUserId || result.interruptedByActorType || result.queuedCommentInterruptQueueId) {
      cancellation = requestedRunCancellation(result, error ?? run.error ?? "Execution stopped");
    } else {
      const source = code === "duplex_channel_lost" ? "transport" : result.status === "cancelled" ? "provider" : "unknown";
      const description = source === "provider" ? "Provider cancelled execution"
        : source === "transport" ? "Connection to the execution provider was lost"
        : "Execution stopped without a recorded cancellation request";
      const detail = error ?? run.error;
      cancellation = { source, expected: false, initiator: { type: source === "provider" ? "provider" : "system" },
        reason: (!detail || /^cancelled\.?$/i.test(detail) ? description : `${description}: ${detail}`).slice(0, 512),
        recordedAt: new Date().toISOString() };
    }
  }
  return { ...result, cancellation };
}

/** Eligibility only; admission still verifies process/lease shutdown and gates.
 * Historical ambiguous cancellations and outstanding tools stay held.
 */
export function canContinueCancelledRun(run: Run): boolean {
  const cancellation = readRunCancellation(run.resultJson);
  return run.status === "cancelled" && run.runtimeMode === "legacy" && Boolean(run.startedAt && run.finishedAt) &&
    cancellation?.expected === false && ["provider", "transport"].includes(cancellation.source) &&
    run.resultJson?.acpToolInventoryComplete === true && run.resultJson?.acpPendingToolCount === 0;
}

export function isUnexpectedRunCancellation(run: Run): boolean {
  const bootstrap = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  return run.status === "cancelled" && Boolean(run.startedAt) &&
    !(bootstrap?.kind === "bootstrap" && bootstrap.providerWorkStarted === false) &&
    readRunCancellation(run.resultJson)?.expected !== true;
}
