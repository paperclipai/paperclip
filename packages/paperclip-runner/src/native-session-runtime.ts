import { randomUUID } from "node:crypto";

import type {
  CheckpointControlPlaneSessionOptions,
  ControlPlanePort,
} from "./contracts/control-plane-port.js";
import type {
  NativeExecutionInput,
  NativeSessionExecutionResult,
} from "./contracts/native-execution.js";
import {
  buildNativeModelEnvelope,
  parseNativeExecutionInput,
} from "./contracts/native-execution.js";
import type {
  NativeSession,
  NativeSessionBackend,
} from "./contracts/native-session-backend.js";
import type { PersistedNativeSession } from "./contracts/native-session-backend.js";
import {
  validatePrpStructuredRunResult,
  type PrpEvent,
  type PrpStructuredRunResult,
  type PrpTerminalState,
} from "./protocol/replay-contract.js";
import { parsePaperclipQuestionSet } from "./contracts/question-set.js";

export const DEFAULT_NATIVE_RUNTIME_INPUT_LIVE_WINDOW_MS = 120_000;
export const DEFAULT_NATIVE_SEMANTIC_RESULT_TERMINAL_GRACE_MS = 5_000;
const OPTIONAL_SESSION_CANCELLATION_GRACE_MS = 100;
const FAILED_OPERATION_SETTLEMENT_GRACE_MS = 100;
const DEFAULT_NATIVE_CHECKPOINT_TIMEOUT_MS = 30_000;
type NativeSessionCleanupDomain = string;

const failedSessionCleanupOwners = new Map<
  Promise<void>,
  NativeSessionCleanupDomain
>();
const FAILED_SESSION_CLOSE_RETRY_MS = 1_000;
const MAX_FAILED_SESSION_CLOSE_RETRIES = 3;
const MAX_QUARANTINED_SESSION_CLOSE_RETRIES = 3;
const MAX_QUARANTINED_SESSION_AUTOMATIC_CLOSE_ATTEMPTS = 9;
const QUARANTINED_SESSION_CLOSE_RETRY_MS = 60_000;
// Admission can inherit the initial close plus all three retained retries.
// Keep the wait finite while covering every bounded close attempt and all
// three production retry delays instead of timing out midway through recovery.
const QUARANTINED_SESSION_CLOSE_ATTEMPT_BOUND_MS = 7_000;
const QUARANTINED_SESSION_ADMISSION_GRACE_MS =
  (MAX_FAILED_SESSION_CLOSE_RETRIES + 1) *
    QUARANTINED_SESSION_CLOSE_ATTEMPT_BOUND_MS +
  MAX_FAILED_SESSION_CLOSE_RETRIES * FAILED_SESSION_CLOSE_RETRY_MS;
// Admission can observe a retained close recovery and then the one quarantine
// recovery that retained owner installs when it exhausts its retries. Give
// each owner generation a complete finite grace, while rejecting any
// unexpected third generation instead of permitting an unbounded owner chain.
const MAX_QUARANTINED_SESSION_ADMISSION_OWNER_PHASES = 2;

interface QuarantinedSessionCleanup {
  session: NativeSession;
  domain: NativeSessionCleanupDomain;
  automaticAttempts: number;
  attempt: Promise<void> | null;
  recovery: Promise<void> | null;
  recoveryMaxAttempts: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const quarantinedSessionCleanups = new Set<QuarantinedSessionCleanup>();

export interface ExecuteNativeSessionOptions {
  input: NativeExecutionInput;
  backend: NativeSessionBackend;
  controlPlane: ControlPlanePort;
  runnerInstanceId: string;
  controlPlaneInstanceId: string;
  timeoutMs?: number;
  /** Abort admission while waiting for prior cleanup in the same domain. */
  signal?: AbortSignal;
  /** Internal test seam; production bounds checkpoint persistence to 30 seconds. */
  checkpointTimeoutMs?: number;
  /** Internal test seam; production uses the fixed 120-second platform policy. */
  runtimeInputLiveWindowMs?: number;
  /** Internal test seam; production gives the provider five seconds to end after a result. */
  semanticResultTerminalGraceMs?: number;
  onSession?: (session: NativeSession | null) => void;
  existingSession?: NativeSession;
  persistedSession?: PersistedNativeSession | null;
  keepSessionOpen?: boolean;
  /**
   * Wait for the backend's close contract before returning a durable result.
   * Use this only for backends whose close path is internally bounded and
   * carries required persistence (for example, a remote runner checkpoint).
   */
  requireSessionCloseBeforeReturn?: boolean;
  onCheckpoint?: (
    snapshot: PersistedNativeSession,
    options?: CheckpointControlPlaneSessionOptions,
  ) => Promise<void> | void;
  /** Called when exact provider recovery failed and policy opened a new provider session. */
  onContinuityBreak?: (input: {
    reason: string;
    previousDriverSessionId: string;
    previousProviderSessionId: string | null;
    replacementDriverSessionId: string;
    replacementProviderSessionId: string | null;
  }) => Promise<void> | void;
  /**
   * Control-plane policy seam for a provider turn that completed after
   * durably creating a governed wait, but did not emit a semantic finish
   * result. The runner package cannot inspect server-owned interactions, so
   * it asks the embedding control plane whether that missing result is an
   * intentional yield before treating it as provider failure.
   */
  resolveMissingResult?: (input: {
    turnId: string | null;
    terminalEvent: PrpEvent;
  }) => Promise<PrpStructuredRunResult | null>;
  /**
   * Detect a durable server-owned wait as soon as its provider tool event is
   * committed. Models are not trusted to stop or avoid polling after creating
   * a question/review interaction; the control plane may park the turn here.
   * This boundary is deliberately synchronous and observational: asynchronous
   * mutation authority cannot be revoked safely after a failed execution.
   */
  resolveGovernedWait?: (input: {
    turnId: string | null;
    event: PrpEvent;
  }) => PrpStructuredRunResult | null;
}

function isTurnTerminal(event: PrpEvent): boolean {
  return [
    "turn.completed",
    "turn.failed",
    "turn.interrupted",
    "turn.cancelled",
  ].includes(event.eventType);
}

function terminalFromEvent(
  event: PrpEvent,
  disposition: PrpTerminalState["reportedWorkDisposition"],
): PrpTerminalState {
  const states =
    event.eventType === "turn.completed"
      ? {
          turnTerminalState: "completed" as const,
          runTerminalState: "succeeded" as const,
        }
      : event.eventType === "turn.failed"
        ? {
            turnTerminalState: "failed" as const,
            runTerminalState: "failed" as const,
          }
        : event.eventType === "turn.interrupted"
          ? {
              turnTerminalState: "interrupted" as const,
              runTerminalState: "cancelled" as const,
            }
          : {
              turnTerminalState: "cancelled" as const,
              runTerminalState: "cancelled" as const,
            };
  return {
    schema: "paperclip.prp.terminal.v1",
    ...states,
    reportedWorkDisposition: disposition,
  };
}

async function attemptOptionalSessionCancellation(
  session: NativeSession,
  reason: string,
): Promise<{ settlement: Promise<PromiseSettledResult<void>[]> } | null> {
  if (session.cancel === undefined) return null;
  const cancellationAbort = new AbortController();
  let cleanup: Promise<void>;
  try {
    // The session commits cancellation before returning. Only provider
    // cleanup remains asynchronous, so bounded failure settlement cannot
    // leave an operation with accepted-output or mutation authority.
    cleanup = session.cancel({
      reason,
      signal: cancellationAbort.signal,
    }).cleanup;
  } catch {
    return null;
  }
  const attempts = Promise.allSettled([cleanup]);
  if (await settlesWithin(attempts, OPTIONAL_SESSION_CANCELLATION_GRACE_MS)) {
    return null;
  }
  cancellationAbort.abort(
    new Error("native session cancellation grace expired"),
  );
  return { settlement: attempts };
}

async function settlesWithin(
  operation: Promise<unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort = () => {};
  try {
    const aborted = signal
      ? new Promise<never>((_resolve, reject) => {
          const onAbort = () =>
            reject(
              signal.reason ??
                new Error("native session cleanup admission aborted"),
            );
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
            removeAbort = () => signal.removeEventListener("abort", onAbort);
          }
        })
      : new Promise<never>(() => undefined);
    return await Promise.race([
      operation.then(() => true),
      new Promise<false>((resolve) => {
        graceTimer = setTimeout(() => resolve(false), timeoutMs);
        graceTimer.unref?.();
      }),
      aborted,
    ]);
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    removeAbort();
  }
}

async function runAbortableOperationWithin<T>(input: {
  timeoutMs: number;
  timeoutMessage: string;
  timeoutError?: () => Error;
  operation: (signal: AbortSignal) => Promise<T>;
  onLateResolution?: (value: T) => Promise<void> | void;
}): Promise<T> {
  const operationAbort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let timeoutError: Error | undefined;
  const operation = input.operation(operationAbort.signal);
  // The timeout path deliberately stops awaiting an uncooperative adapter.
  // Keep its eventual settlement observed after mutation authority is revoked.
  void operation.catch(() => undefined);
  if (input.onLateResolution !== undefined) {
    void operation.then(
      (value) => {
        if (!timedOut) return;
        void Promise.resolve()
          .then(() => input.onLateResolution!(value))
          .catch(() => undefined);
      },
      () => undefined,
    );
  }
  try {
    const value = await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error =
            input.timeoutError?.() ?? new Error(input.timeoutMessage);
          timedOut = true;
          timeoutError = error;
          reject(error);
          operationAbort.abort(error);
        }, input.timeoutMs);
        timer.unref?.();
      }),
    ]);
    // An abort listener can resolve synchronously before the timeout promise's
    // rejection wins the race. The deadline still owns that boundary: the late
    // result is disposed above and must never be admitted by the caller.
    if (timedOut) throw timeoutError;
    return value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function disposeUnadmittedSession(
  session: NativeSession,
  reason: string,
  cleanupDomain: NativeSessionCleanupDomain,
): Promise<void> {
  // A provider may ignore abort and return a session after its caller has
  // already timed out. That session was never published through onSession, so
  // close it without clearing ownership that a later execution may establish.
  // Retain slow or failed cleanup in the same admission gate as an admitted
  // session: the absence of an onSession publication does not mean provider
  // resources have already been released.
  const cleanup = retainUnadmittedSessionCleanup(
    session,
    reason,
    cleanupDomain,
  );
  await settlesWithin(
    Promise.allSettled([cleanup]),
    FAILED_OPERATION_SETTLEMENT_GRACE_MS,
  );
}

function retainUnadmittedSessionCleanup(
  session: NativeSession,
  reason: string,
  cleanupDomain: NativeSessionCleanupDomain,
): Promise<void> {
  const cleanup = (async () => {
    let attempt = Promise.resolve().then(() => session.close({ reason }));
    let retryCount = 0;
    while (true) {
      try {
        await attempt;
        return;
      } catch (error) {
        if (retryCount >= MAX_FAILED_SESSION_CLOSE_RETRIES) {
          quarantineSessionCleanup(session, cleanupDomain);
          throw error;
        }
        retryCount += 1;
        await waitForSessionCloseRetry();
        attempt = Promise.resolve().then(() =>
          session.close({
            reason: `${reason} cleanup recovery (${retryCount})`,
          }),
        );
      }
    }
  })();
  retainFailedSessionCleanupOwner(cleanup, cleanupDomain);
  return cleanup;
}

class NativeSessionFinalizationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`native session finalization timed out after ${timeoutMs}ms`);
    this.name = "NativeSessionFinalizationTimeoutError";
  }
}

async function finalizeWithin<T>(input: {
  timeoutMs: number;
  operation: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  return runAbortableOperationWithin({
    ...input,
    timeoutMessage: `native session finalization timed out after ${input.timeoutMs}ms`,
    timeoutError: () =>
      new NativeSessionFinalizationTimeoutError(input.timeoutMs),
  });
}

async function finalizeIdempotentControlPlaneWithin<T>(input: {
  timeoutMs: number;
  operation: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  try {
    return await finalizeWithin(input);
  } catch (error) {
    if (!(error instanceof NativeSessionFinalizationTimeoutError)) throw error;
    // Only the deterministic control-plane transaction enters this retry.
    // Its event ids and completion dedupe key make the second settlement an
    // authoritative acknowledgement of any first-attempt commit. Provider
    // result resolution and checkpointing are deliberately outside this
    // boundary and are never started a second time.
    return finalizeWithin(input);
  }
}

async function quarantineRetainedSession(
  session: NativeSession,
  onSession: ExecuteNativeSessionOptions["onSession"],
  reason: string,
  cleanupDomain: NativeSessionCleanupDomain,
): Promise<void> {
  // Eviction and provider cleanup are independent obligations. Keep both
  // observed so a throwing owner callback cannot prevent close from starting,
  // and a broken provider cannot keep the failed execution pending forever.
  const quarantineSettlement = Promise.allSettled([
    Promise.resolve().then(() => onSession?.(null)),
    retainUnadmittedSessionCleanup(session, reason, cleanupDomain),
  ]);
  await settlesWithin(
    quarantineSettlement,
    FAILED_OPERATION_SETTLEMENT_GRACE_MS,
  );
}

async function persistCheckpointWithin(input: {
  snapshot: PersistedNativeSession;
  controlPlane: ControlPlanePort;
  onCheckpoint: ExecuteNativeSessionOptions["onCheckpoint"];
  timeoutMs: number;
  externalSignal?: AbortSignal;
}): Promise<void> {
  const checkpointAbort = new AbortController();
  const externalSignal = input.externalSignal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeExternalAbort = () => {};
  const externalAbortFailure = externalSignal
    ? new Promise<never>((_resolve, reject) => {
        const abort = () => {
          const reason =
            externalSignal.reason ??
            new Error("native session checkpoint aborted");
          checkpointAbort.abort(reason);
          reject(reason);
        };
        if (externalSignal.aborted) {
          abort();
        } else {
          externalSignal.addEventListener("abort", abort, { once: true });
          removeExternalAbort = () =>
            externalSignal.removeEventListener("abort", abort);
        }
      })
    : new Promise<never>(() => undefined);
  const checkpointing = (async () => {
    const checkpointOptions = { signal: checkpointAbort.signal };
    await input.controlPlane.checkpointSession?.(
      input.snapshot,
      checkpointOptions,
    );
    if (checkpointAbort.signal.aborted) {
      throw (
        checkpointAbort.signal.reason ??
        new Error("native session checkpoint aborted")
      );
    }
    await input.onCheckpoint?.(input.snapshot, checkpointOptions);
  })();
  // The timeout path intentionally stops awaiting an uncooperative adapter.
  // Keep its eventual rejection observed after execution has quarantined and
  // closed the provider session.
  void checkpointing.catch(() => undefined);
  try {
    await Promise.race([
      checkpointing,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(
            `native session checkpoint timed out after ${input.timeoutMs}ms`,
          );
          checkpointAbort.abort(error);
          reject(error);
        }, input.timeoutMs);
      }),
      externalAbortFailure,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeExternalAbort();
  }
}

function waitForSessionCloseRetry(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, FAILED_SESSION_CLOSE_RETRY_MS);
    timer.unref?.();
  });
}
function retainFailedSessionCleanupOwner(
  cleanup: Promise<void>,
  cleanupDomain: NativeSessionCleanupDomain,
): void {
  failedSessionCleanupOwners.set(cleanup, cleanupDomain);
  void cleanup
    .finally(() => failedSessionCleanupOwners.delete(cleanup))
    .catch(() => undefined);
}

function quarantineSessionCleanup(
  session: NativeSession,
  cleanupDomain: NativeSessionCleanupDomain,
): void {
  if (
    [...quarantinedSessionCleanups].some((entry) => entry.session === session)
  ) {
    return;
  }
  const cleanup: QuarantinedSessionCleanup = {
    session,
    domain: cleanupDomain,
    automaticAttempts: 0,
    attempt: null,
    recovery: null,
    recoveryMaxAttempts: null,
    timer: null,
  };
  quarantinedSessionCleanups.add(cleanup);
  startQuarantinedSessionCleanupRecovery(
    cleanup,
    MAX_QUARANTINED_SESSION_CLOSE_RETRIES,
    "native session quarantined cleanup recovery",
  );
}

function startQuarantinedSessionCleanupRecovery(
  cleanup: QuarantinedSessionCleanup,
  maxAttempts: number,
  reason: string,
): Promise<void> {
  if (cleanup.recovery) return cleanup.recovery;
  const remainingAttempts =
    MAX_QUARANTINED_SESSION_AUTOMATIC_CLOSE_ATTEMPTS -
    cleanup.automaticAttempts;
  const boundedMaxAttempts = Math.min(maxAttempts, remainingAttempts);
  if (boundedMaxAttempts <= 0) return Promise.resolve();
  const recovery = (async () => {
    for (
      let attemptCount = 0;
      attemptCount < boundedMaxAttempts &&
      quarantinedSessionCleanups.has(cleanup);
      attemptCount += 1
    ) {
      // The first retry starts immediately so an admission-triggered recovery
      // receives the complete close grace. Later attempts retain the bounded
      // delay that prevents a hot retry loop.
      if (attemptCount > 0) await waitForSessionCloseRetry();
      cleanup.automaticAttempts += 1;
      const attempt = Promise.resolve().then(() =>
        cleanup.session.close({
          reason,
        }),
      );
      cleanup.attempt = attempt;
      try {
        await attempt;
        quarantinedSessionCleanups.delete(cleanup);
      } catch {
        // Retain the quarantine after this finite, sequential retry batch.
      } finally {
        if (cleanup.attempt === attempt) cleanup.attempt = null;
      }
    }
  })();
  cleanup.recovery = recovery;
  cleanup.recoveryMaxAttempts = boundedMaxAttempts;
  failedSessionCleanupOwners.set(recovery, cleanup.domain);
  void recovery
    .finally(() => {
      failedSessionCleanupOwners.delete(recovery);
      if (cleanup.recovery === recovery) {
        cleanup.recovery = null;
        cleanup.recoveryMaxAttempts = null;
      }
      scheduleQuarantinedSessionCleanup(cleanup);
    })
    .catch(() => undefined);
  return recovery;
}

function scheduleQuarantinedSessionCleanup(
  cleanup: QuarantinedSessionCleanup,
): void {
  if (
    !quarantinedSessionCleanups.has(cleanup) ||
    cleanup.recovery ||
    cleanup.attempt ||
    cleanup.timer ||
    cleanup.automaticAttempts >=
      MAX_QUARANTINED_SESSION_AUTOMATIC_CLOSE_ATTEMPTS
  ) {
    return;
  }
  // Keep cleanup live without a hot retry loop: one unref'd timer and one
  // sequential close are the maximum background work owned by each entry.
  // A later admission may accelerate, but never overlap, the scheduled try.
  cleanup.timer = setTimeout(() => {
    cleanup.timer = null;
    if (!quarantinedSessionCleanups.has(cleanup)) return;
    startQuarantinedSessionCleanupRecovery(
      cleanup,
      1,
      "native session scheduled quarantined cleanup recovery",
    );
  }, QUARANTINED_SESSION_CLOSE_RETRY_MS);
  cleanup.timer.unref?.();
}

async function retryQuarantinedSessionCleanups(
  cleanupDomain: NativeSessionCleanupDomain,
  signal?: AbortSignal,
): Promise<void> {
  // A close attempt becomes admission-visible as soon as the runtime retains
  // its exact cleanup owner. It may not have rejected yet, so it may not have
  // entered the retry quarantine below. Observe both states through the same
  // finite gate to prevent a later execution from opening a second provider
  // session while the first close still owns provider resources.
  const observedOwners = new Set<Promise<void>>();
  const acceleratedCleanups = new Set<QuarantinedSessionCleanup>();
  let observedOwnerPhases = 0;
  while (true) {
    signal?.throwIfAborted();
    const cleanupOwners = new Set<Promise<void>>(
      [...failedSessionCleanupOwners]
        .filter(([, domain]) => domain === cleanupDomain)
        .map(([owner]) => owner),
    );
    for (const cleanup of quarantinedSessionCleanups) {
      if (cleanup.domain !== cleanupDomain) continue;
      if (cleanup.timer) {
        clearTimeout(cleanup.timer);
        cleanup.timer = null;
      }
      if (cleanup.recovery) {
        // An autonomous scheduled owner receives one attempt. Admission must
        // observe it without mistaking it for the complete three-attempt
        // admission batch; if that attempt fails, the next bounded owner
        // phase accelerates one full batch. Existing full recoveries already
        // consumed that allowance and are never duplicated.
        if (
          (cleanup.recoveryMaxAttempts ?? 0) >=
          MAX_QUARANTINED_SESSION_CLOSE_RETRIES
        ) {
          acceleratedCleanups.add(cleanup);
        }
        cleanupOwners.add(cleanup.recovery);
      } else if (!acceleratedCleanups.has(cleanup)) {
        acceleratedCleanups.add(cleanup);
        if (
          cleanup.automaticAttempts <
          MAX_QUARANTINED_SESSION_AUTOMATIC_CLOSE_ATTEMPTS
        ) {
          cleanupOwners.add(
            startQuarantinedSessionCleanupRecovery(
              cleanup,
              MAX_QUARANTINED_SESSION_CLOSE_RETRIES,
              "native session quarantined admission recovery",
            ),
          );
        }
      }
    }
    const replacementOwners = [...cleanupOwners].filter(
      (owner) => !observedOwners.has(owner),
    );
    if (replacementOwners.length === 0) break;
    replacementOwners.forEach((owner) => observedOwners.add(owner));
    observedOwnerPhases += 1;
    if (
      observedOwnerPhases > MAX_QUARANTINED_SESSION_ADMISSION_OWNER_PHASES ||
      !(await settlesWithin(
        Promise.all(
          replacementOwners.map((owner) => owner.catch(() => undefined)),
        ),
        QUARANTINED_SESSION_ADMISSION_GRACE_MS,
        signal,
      ))
    ) {
      throw new Error(
        "native_session_cleanup_quarantined: prior session cleanup exceeded the admission grace",
      );
    }
  }
  if (
    [...failedSessionCleanupOwners.values()].some(
      (domain) => domain === cleanupDomain,
    ) ||
    [...quarantinedSessionCleanups].some(
      (cleanup) => cleanup.domain === cleanupDomain,
    )
  ) {
    // Admission may have pulled a scheduled retry forward and observed a
    // complete recovery batch that still failed. Restore autonomous ownership
    // before rejecting so cleanup cannot remain dormant until another run.
    for (const cleanup of quarantinedSessionCleanups) {
      if (cleanup.domain !== cleanupDomain) continue;
      scheduleQuarantinedSessionCleanup(cleanup);
    }
    throw new Error(
      "native_session_cleanup_quarantined: prior session cleanup remains incomplete",
    );
  }
}
async function consumeTurn(
  session: NativeSession,
  controlPlane: ControlPlanePort,
  timeoutMs: number,
  runtimeInputLiveWindowMs: number,
  semanticResultTerminalGraceMs: number,
  closeFailedSession: () => Promise<void>,
  quarantineSession: () => void,
  resolveGovernedWait?: ExecuteNativeSessionOptions["resolveGovernedWait"],
  externalSignal?: AbortSignal,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let semanticResultTimer: ReturnType<typeof setTimeout> | undefined;
  const semanticResultGraceExpired = Symbol("semantic_result_grace_expired");
  const appendAbort = new AbortController();
  const governedCleanupOperations = new Set<Promise<unknown>>();
  let governedCancellationCommitted = false;
  let deferredGovernedCleanupSettlement: Promise<unknown> | null = null;
  let deferredSessionCancellationSettlement: Promise<unknown> | null = null;
  const inputTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const handoffCleanupOperations = new Set<Promise<unknown>>();
  const eventIterator = session.events()[Symbol.asyncIterator]();
  let stopConsumer = false;
  let rejectHandoff: ((error: unknown) => void) | null = null;
  const handoffFailure = new Promise<never>((_resolve, reject) => {
    rejectHandoff = reject;
  });
  let removeExternalAbort = () => {};
  const externalAbortFailure = externalSignal
    ? new Promise<never>((_resolve, reject) => {
        const abort = () => {
          const reason =
            externalSignal.reason ??
            new Error("native event consumption aborted");
          stopConsumer = true;
          appendAbort.abort(reason);
          reject(reason);
        };
        if (externalSignal.aborted) {
          abort();
        } else {
          externalSignal.addEventListener("abort", abort, { once: true });
          removeExternalAbort = () =>
            externalSignal.removeEventListener("abort", abort);
        }
      })
    : new Promise<never>(() => undefined);
  const clearInputTimer = (requestId: string) => {
    const inputTimer = inputTimers.get(requestId);
    if (inputTimer !== undefined) clearTimeout(inputTimer);
    inputTimers.delete(requestId);
  };
  const consumer = (async () => {
    let eventCount = 0;
    let highestContiguousSourceSeq = 0;
    let governedResult: PrpStructuredRunResult | null = null;
    let resultSource: "semantic_result" | "governed_wait" | null = null;
    let semanticResultEvent: PrpEvent | null = null;
    let semanticResultDeadline: Promise<
      typeof semanticResultGraceExpired
    > | null = null;
    let pendingNext: ReturnType<typeof eventIterator.next> | null = null;
    const settleDurableResult = (
      event: PrpEvent,
      result: PrpStructuredRunResult,
      reason: string,
    ) => {
      if (session.cancel === undefined) {
        throw new Error("native_governed_wait_cancellation_unavailable");
      }
      const cancellation = session.cancel({
        reason,
        signal: appendAbort.signal,
      });
      governedCancellationCommitted = true;
      const cleanup = cancellation.cleanup;
      governedCleanupOperations.add(cleanup);
      void cleanup
        .catch(() => quarantineSession())
        .finally(() => governedCleanupOperations.delete(cleanup));
      return {
        event,
        eventCount,
        highestContiguousSourceSeq,
        governedResult: result,
      };
    };
    while (true) {
      pendingNext ??= eventIterator.next();
      const next =
        semanticResultDeadline === null
          ? await pendingNext
          : await Promise.race([pendingNext, semanticResultDeadline]);
      if (next === semanticResultGraceExpired) {
        void pendingNext.catch(() => undefined);
        if (semanticResultEvent === null || governedResult === null) {
          throw new Error("native_semantic_result_grace_lost_result");
        }
        return settleDurableResult(
          semanticResultEvent,
          governedResult,
          "Paperclip accepted the durable semantic result.",
        );
      }
      pendingNext = null;
      if (stopConsumer) throw new Error("native event consumer stopped");
      if (next.done) {
        if (
          resultSource === "semantic_result" &&
          semanticResultEvent !== null &&
          governedResult !== null
        ) {
          return {
            event: semanticResultEvent,
            eventCount,
            highestContiguousSourceSeq,
            governedResult,
          };
        }
        throw new Error(
          "native event stream closed before a turn terminal fact",
        );
      }
      const event = next.value;
      const payload = event.payload as Record<string, unknown>;
      const settlingRequestId =
        [
          "runtime_request.resolved",
          "runtime_request.cancelled",
          "runtime_request.expired",
        ].includes(event.eventType) && typeof payload.requestId === "string"
          ? payload.requestId
          : null;
      // Beginning settlement revokes the expiry timer's handoff authority.
      // appendEvent may remain pending across the live-window deadline; if
      // the timer stayed live until the receipt returned, both settlement
      // and a durable handoff could commit for the same request.
      if (settlingRequestId !== null) clearInputTimer(settlingRequestId);
      const receipt = await controlPlane.appendEvent(event, {
        signal: appendAbort.signal,
      });
      if (stopConsumer) throw new Error("native event consumer stopped");
      eventCount += receipt.disposition === "committed" ? 1 : 0;
      highestContiguousSourceSeq = Math.max(
        highestContiguousSourceSeq,
        receipt.highestContiguousSourceSeq,
      );
      const request =
        payload.request &&
        typeof payload.request === "object" &&
        !Array.isArray(payload.request)
          ? (payload.request as Record<string, unknown>)
          : null;
      if (
        receipt.disposition === "committed" &&
        event.eventType === "runtime_request.created" &&
        request?.schema === "paperclip.runtime_request.v2" &&
        request.type === "input" &&
        typeof request.requestId === "string" &&
        typeof request.turnId === "string"
      ) {
        try {
          parsePaperclipQuestionSet(request.input);
          const requestId = request.requestId;
          const turnId = request.turnId;
          clearInputTimer(requestId);
          const inputTimer = setTimeout(() => {
            // Clearing a timeout does not revoke a callback that is already
            // queued. The map entry is the per-request authority token.
            if (inputTimers.get(requestId) !== inputTimer) return;
            inputTimers.delete(requestId);
            // A timer callback can already be queued when teardown clears
            // its handle. Re-check the live-turn authority inside the
            // callback before starting or registering durable work.
            if (stopConsumer || appendAbort.signal.aborted) return;
            if (session.handoffRuntimeRequest === undefined) {
              rejectHandoff?.(
                new Error("native_runtime_request_handoff_unavailable"),
              );
              return;
            }
            let handoffCleanup: Promise<unknown>;
            try {
              const handoff = session.handoffRuntimeRequest({
                requestId,
                turnId,
                reason: "durable_handoff",
                signal: appendAbort.signal,
              });
              // Durable handoff mutation is synchronous. The returned
              // promise owns provider interruption only, so it can remain
              // observed without acquiring authority to delay or reverse
              // a provider terminal fact.
              handoffCleanup = handoff.cleanup;
            } catch (error) {
              rejectHandoff?.(error);
              return;
            }
            handoffCleanupOperations.add(handoffCleanup);
            void handoffCleanup
              .catch((error) => {
                if (!stopConsumer && !appendAbort.signal.aborted) {
                  rejectHandoff?.(error);
                }
              })
              .finally(() => handoffCleanupOperations.delete(handoffCleanup));
          }, runtimeInputLiveWindowMs);
          inputTimer.unref?.();
          inputTimers.set(requestId, inputTimer);
        } catch {
          // Invalid structured inputs remain rejected by the driver and never become durable questions.
        }
      }
      if (
        governedResult === null &&
        event.eventType === "run.result.proposed"
      ) {
        const validation = validatePrpStructuredRunResult(event.payload);
        if (!validation.ok) {
          throw new Error("native_semantic_result_invalid");
        }
        governedResult = validation.result;
        resultSource = "semantic_result";
        semanticResultEvent = event;
        if (session.cancel !== undefined) {
          semanticResultDeadline = new Promise((resolve) => {
            semanticResultTimer = setTimeout(
              () => resolve(semanticResultGraceExpired),
              semanticResultTerminalGraceMs,
            );
            semanticResultTimer.unref?.();
          });
        }
      }
      if (governedResult === null && resolveGovernedWait) {
        if (appendAbort.signal.aborted) {
          throw (
            appendAbort.signal.reason ??
            new Error("native event consumption aborted")
          );
        }
        governedResult = resolveGovernedWait({
          turnId: event.turnId ?? null,
          event,
        });
        if (governedResult !== null) resultSource = "governed_wait";
      }
      if (governedResult !== null && !isTurnTerminal(event)) {
        if (resultSource === "semantic_result") {
          // Give the provider a short grace to publish its final assistant
          // message and terminal after the semantic tool returns. If no
          // terminal arrives, the deadline above finalizes the durable result.
          continue;
        }
        return settleDurableResult(
          event,
          governedResult,
          "Paperclip parked this turn on a durable governed interaction.",
        );
      }
      if (isTurnTerminal(event)) {
        return {
          event,
          eventCount,
          highestContiguousSourceSeq,
          governedResult,
        };
      }
    }
  })();
  // A timeout can win the race while an iterator is still waiting for data.
  // Observe any later consumer rejection so it cannot become process-fatal.
  void consumer.catch(() => undefined);
  let consumptionFailed = false;
  try {
    return await Promise.race([
      consumer,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`native session timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
      handoffFailure,
      externalAbortFailure,
    ]);
  } catch (error) {
    consumptionFailed = true;
    stopConsumer = true;
    appendAbort.abort(error);
    for (const inputTimer of inputTimers.values()) clearTimeout(inputTimer);
    inputTimers.clear();
    // Governed-wait discovery is synchronous and observational, and provider
    // cancellation has already committed synchronously. Bound only the
    // authority-free provider cleanup while keeping its outcome observed.
    if (governedCleanupOperations.size > 0) {
      const governedCleanupSettlement = Promise.allSettled([
        ...governedCleanupOperations,
      ]);
      if (
        !(await settlesWithin(
          governedCleanupSettlement,
          FAILED_OPERATION_SETTLEMENT_GRACE_MS,
        ))
      ) {
        deferredGovernedCleanupSettlement = governedCleanupSettlement;
      }
    }
    if (!governedCancellationCommitted) {
      const deferredCancellation = await attemptOptionalSessionCancellation(
        session,
        "Native session event consumption failed.",
      );
      deferredSessionCancellationSettlement =
        deferredCancellation?.settlement ?? null;
    }
    throw error;
  } finally {
    stopConsumer = true;
    for (const inputTimer of inputTimers.values()) clearTimeout(inputTimer);
    inputTimers.clear();
    const activeHandoffCleanupSettlement =
      handoffCleanupOperations.size > 0
        ? Promise.allSettled([...handoffCleanupOperations])
        : null;
    const activeGovernedCleanupSettlement =
      deferredGovernedCleanupSettlement === null &&
      governedCleanupOperations.size > 0
        ? Promise.allSettled([...governedCleanupOperations])
        : null;
    if (!consumptionFailed && !appendAbort.signal.aborted) {
      // A provider terminal or synchronous governed cancellation revokes
      // live-turn authority. Handoff state was already committed; abort only
      // tells provider cleanup that it must not begin any new work.
      appendAbort.abort(new Error("native turn reached a terminal state"));
    }
    // Do not let failure escape while the provider iterator still owns a live
    // subscription. Cancellation above is responsible for releasing a blocked
    // `next()`; awaiting `return()` then synchronizes the iterator's `finally`
    // teardown before the session can be closed or reused.
    const iteratorTeardown = eventIterator.return?.().catch(() => undefined);
    // The consumer may already be past `next()` and awaiting a durable append.
    // Abort is a control-plane durability boundary: appendEvent must settle
    // without committing when its signal is aborted. Handoff and cancellation
    // promises below own provider cleanup only; their durable transitions were
    // synchronous, so a slow cleanup cannot reverse terminal completion.
    const passiveTeardownSettlement = Promise.allSettled([
      iteratorTeardown,
      consumer,
      ...(activeHandoffCleanupSettlement
        ? [activeHandoffCleanupSettlement]
        : []),
      ...(activeGovernedCleanupSettlement
        ? [activeGovernedCleanupSettlement]
        : []),
      ...(deferredGovernedCleanupSettlement
        ? [deferredGovernedCleanupSettlement]
        : []),
      ...(deferredSessionCancellationSettlement
        ? [deferredSessionCancellationSettlement]
        : []),
    ]);
    if (consumptionFailed) {
      // Start provider close immediately so a cooperative implementation can
      // release a blocked iterator or provider operation. Abort has already
      // revoked every control-plane mutation capability and closeSession has
      // removed this session from the caller, so an implementation that
      // violates its cancellation contract is quarantined rather than allowed
      // to defeat the execution deadline. Promise.allSettled keeps every late
      // rejection observed after the bounded wait expires.
      const cleanupSettlement = Promise.allSettled([
        passiveTeardownSettlement,
        Promise.resolve().then(closeFailedSession),
      ]);
      await settlesWithin(
        cleanupSettlement,
        FAILED_OPERATION_SETTLEMENT_GRACE_MS,
      );
    } else {
      // Iterator and provider cleanup own no control-plane mutation authority.
      // A slow subscription or cleanup remains observed and is released by the
      // normal session close, but it cannot erase an already committed
      // terminal fact or prevent result retrieval and durable finalization.
      const teardownSettled = await settlesWithin(
        passiveTeardownSettlement,
        FAILED_OPERATION_SETTLEMENT_GRACE_MS,
      );
      if (!teardownSettled) quarantineSession();
    }
    if (timer !== undefined) clearTimeout(timer);
    if (semanticResultTimer !== undefined) clearTimeout(semanticResultTimer);
    removeExternalAbort();
  }
}

function checkpointCursor(cursor: string | null | undefined): number {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  const parsed = Number(cursor);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

async function reconcileRecoveryCursor(input: {
  controlPlane: ControlPlanePort;
  checkpoint: PersistedNativeSession;
  runId: string;
  sourceInstanceId: string;
  signal: AbortSignal;
}): Promise<PersistedNativeSession> {
  const checkpointHighWater = checkpointCursor(input.checkpoint.cursor);
  let afterSourceSeq = checkpointHighWater;
  let persistedHighWater = checkpointHighWater;
  while (true) {
    const replay = await input.controlPlane.replayEvents(
      {
        runId: input.runId,
        sourceInstanceId: input.sourceInstanceId,
        afterSourceSeq,
        limit: 1_000,
      },
      { signal: input.signal },
    );
    input.signal.throwIfAborted();
    if (replay.events.length === 0) break;
    const pageHighWater = replay.events.reduce(
      (highest, event) => Math.max(highest, event.sourceSeq),
      afterSourceSeq,
    );
    if (pageHighWater <= afterSourceSeq) {
      throw new Error("native_recovery_replay_did_not_advance");
    }
    persistedHighWater = Math.max(persistedHighWater, pageHighWater);
    afterSourceSeq = pageHighWater;
  }
  if (
    persistedHighWater === checkpointHighWater &&
    input.checkpoint.cursor === String(checkpointHighWater)
  ) {
    return input.checkpoint;
  }
  return { ...input.checkpoint, cursor: String(persistedHighWater) };
}

async function replayCheckpointedTurnTerminal(input: {
  controlPlane: ControlPlanePort;
  runId: string;
  sourceInstanceId: string;
  priorTerminalTurnIds: readonly string[];
  expectedTurnId?: string | null;
}): Promise<{ terminal: PrpEvent; hasPriorResultProposal: boolean } | null> {
  let afterSourceSeq = 0;
  const terminals: PrpEvent[] = [];
  const latestResultProposalByTurn = new Map<string, number>();
  const priorTerminalTurnIds = new Set(input.priorTerminalTurnIds);
  while (true) {
    const replay = await input.controlPlane.replayEvents({
      runId: input.runId,
      sourceInstanceId: input.sourceInstanceId,
      afterSourceSeq,
      limit: 1_000,
    });
    if (replay.events.length === 0) {
      // Disposition recovery owns the newest durable provider terminal. An
      // older task turn may also have a valid proposal, but selecting it would
      // finalize stale work and strand the actual recovery terminal.
      const terminal =
        [...terminals].sort(
          (left, right) => right.sourceSeq - left.sourceSeq,
        )[0] ?? null;
      const proposalSequence =
        latestResultProposalByTurn.get(terminal?.turnId ?? "") ?? 0;
      return terminal === null
        ? null
        : {
            terminal,
            hasPriorResultProposal:
              proposalSequence > 0 && proposalSequence < terminal.sourceSeq,
          };
    }
    for (const event of replay.events) {
      if (event.turnId && event.eventType === "run.result.proposed") {
        latestResultProposalByTurn.set(
          event.turnId,
          Math.max(
            latestResultProposalByTurn.get(event.turnId) ?? 0,
            event.sourceSeq,
          ),
        );
      }
      if (
        event.turnId &&
        isTurnTerminal(event) &&
        (input.expectedTurnId !== undefined && input.expectedTurnId !== null
          ? event.turnId === input.expectedTurnId
          : !priorTerminalTurnIds.has(event.turnId))
      ) {
        terminals.push(structuredClone(event));
      }
    }
    const pageHighWater = replay.events.reduce(
      (highest, event) => Math.max(highest, event.sourceSeq),
      afterSourceSeq,
    );
    if (pageHighWater <= afterSourceSeq) {
      throw new Error("native_recovery_replay_did_not_advance");
    }
    afterSourceSeq = pageHighWater;
  }
}

const EFFECT_FREE_ACPX_USAGE_COUNTERS = [
  "inputTokens",
  "outputTokens",
  "activeSeconds",
  "providerCostUsd",
  "cacheReadTokens",
  "cacheWriteTokens",
] as const;

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isZeroWorkAcpxUsage(payload: Record<string, unknown>): boolean {
  if (payload.kind !== "usage") return false;
  const usage = objectRecord(payload.usage);
  if (
    usage === null ||
    Object.keys(usage).some((key) => key !== "total" && key !== "runDelta")
  ) {
    return false;
  }
  return ["total", "runDelta"].every((sectionName) => {
    const section = objectRecord(usage[sectionName]);
    if (
      section === null ||
      section.requests !== 1 ||
      Object.keys(section).some(
        (key) =>
          key !== "requests" &&
          !EFFECT_FREE_ACPX_USAGE_COUNTERS.includes(
            key as (typeof EFFECT_FREE_ACPX_USAGE_COUNTERS)[number],
          ),
      )
    ) {
      return false;
    }
    return EFFECT_FREE_ACPX_USAGE_COUNTERS.every(
      (counter) => section[counter] === 0,
    );
  });
}

async function replayProvesEffectFreeInitialAcpxTurn(input: {
  controlPlane: ControlPlanePort;
  checkpoint: PersistedNativeSession;
  runId: string;
  sourceInstanceId: string;
}): Promise<boolean> {
  const terminalTurns = input.checkpoint.terminalTurns ?? [];
  if (
    input.checkpoint.driverKind !== "acpx_runtime" ||
    input.checkpoint.semanticResult ||
    input.checkpoint.activeTurnId ||
    terminalTurns.length !== 1 ||
    terminalTurns[0]!.turnId.length === 0
  ) {
    return false;
  }
  const targetTurnId = terminalTurns[0]!.turnId;
  const events: PrpEvent[] = [];
  let afterSourceSeq = 0;
  try {
    while (true) {
      const replay = await input.controlPlane.replayEvents({
        runId: input.runId,
        sourceInstanceId: input.sourceInstanceId,
        afterSourceSeq,
        limit: 1_000,
      });
      if (replay.events.length === 0) break;
      for (const event of replay.events) {
        // An incomplete or reordered replay cannot prove absence of work.
        if (event.sourceSeq !== afterSourceSeq + 1) return false;
        events.push(structuredClone(event));
        afterSourceSeq = event.sourceSeq;
        if (events.length > 10_000) return false;
      }
    }
  } catch {
    return false;
  }

  const submittedIndexes = events.flatMap((event, index) =>
    event.eventType === "turn.submitted" ? [index] : [],
  );
  const startedIndexes = events.flatMap((event, index) =>
    event.turnId === targetTurnId && event.eventType === "turn.started"
      ? [index]
      : [],
  );
  const acceptedIndexes = events.flatMap((event, index) =>
    event.turnId === targetTurnId && event.eventType === "turn.accepted"
      ? [index]
      : [],
  );
  const completedIndexes = events.flatMap((event, index) =>
    event.turnId === targetTurnId && event.eventType === "turn.completed"
      ? [index]
      : [],
  );
  if (
    submittedIndexes.length !== 1 ||
    startedIndexes.length !== 1 ||
    acceptedIndexes.length !== 1 ||
    completedIndexes.length !== 1
  ) {
    return false;
  }
  const submittedIndex = submittedIndexes[0]!;
  const startedIndex = startedIndexes[0]!;
  const acceptedIndex = acceptedIndexes[0]!;
  const completedIndex = completedIndexes[0]!;
  const completedPayload = objectRecord(events[completedIndex]!.payload);
  if (
    startedIndex !== submittedIndex + 1 ||
    acceptedIndex !== startedIndex + 1 ||
    completedIndex <= acceptedIndex ||
    events[submittedIndex]!.turnId != null ||
    completedPayload?.status !== "completed" ||
    (completedPayload?.error !== undefined && completedPayload?.error !== null)
  ) {
    return false;
  }
  if (
    events.some(
      (event, index) =>
        event.turnId === targetTurnId &&
        (index < startedIndex || index > completedIndex),
    )
  ) {
    return false;
  }
  return events
    .slice(acceptedIndex + 1, completedIndex)
    .every(
      (event) =>
        event.turnId === targetTurnId &&
        event.eventType === "item.completed" &&
        isZeroWorkAcpxUsage(event.payload),
    );
}

function checkpointedResultlessDispositionFallback(input: {
  persisted: PersistedNativeSession;
  recovered: PersistedNativeSession;
  controlPlaneInstanceId: string;
}): PrpEvent | null {
  const turnId = input.persisted.dispositionOnlyRecoveryTurnId;
  if (
    !input.persisted.dispositionOnlyRecoveryConsumed ||
    input.persisted.semanticResult ||
    input.persisted.activeTurnId ||
    typeof turnId !== "string" ||
    turnId.length === 0
  )
    return null;
  const persistedTerminal =
    input.persisted.terminalTurns?.filter(
      (terminal) => terminal.turnId === turnId,
    ) ?? [];
  if (
    persistedTerminal.length !== 1 ||
    persistedTerminal[0]!.fingerprint.length === 0
  ) {
    return null;
  }
  const recoveredTurnId = input.recovered.dispositionOnlyRecoveryTurnId;
  const recoveredTerminal =
    input.recovered.terminalTurns?.filter(
      (terminal) => terminal.turnId === recoveredTurnId,
    ) ?? [];
  if (
    !input.recovered.dispositionOnlyRecoveryConsumed ||
    input.recovered.semanticResult ||
    input.recovered.activeTurnId ||
    recoveredTurnId !== turnId ||
    recoveredTerminal.length !== 1 ||
    recoveredTerminal[0]!.fingerprint !== persistedTerminal[0]!.fingerprint ||
    canonicalJson(input.recovered.identity) !==
      canonicalJson(input.persisted.identity)
  ) {
    throw new Error("native_disposition_recovery_checkpoint_conflict");
  }
  return {
    schema: "paperclip.prp.event.v1",
    sourceEventId: `${input.controlPlaneInstanceId}:${input.persisted.identity.runId}:checkpointed-disposition-terminal`,
    sourceSeq: 1,
    sourceInstanceId: input.controlPlaneInstanceId,
    sourceKind: "control_plane",
    runId: input.persisted.identity.runId,
    normalizedSessionId: input.persisted.identity.sessionId,
    turnId,
    eventType: "turn.completed",
    schemaVersion: 1,
    priority: 0,
    emittedAt: new Date().toISOString(),
    payload: {
      recovery: "checkpointed_resultless_disposition",
      terminalFingerprint: persistedTerminal[0]!.fingerprint,
    },
  };
}

/**
 * Package-owned normalized session loop. Paperclip supplies persistence and
 * authority through ControlPlanePort; provider/session behavior stays here.
 */
export async function executeNativeSession(
  options: ExecuteNativeSessionOptions,
): Promise<NativeSessionExecutionResult> {
  const input = parseNativeExecutionInput(options.input);
  const descriptor = await options.backend.descriptor();
  const cleanupDomain = JSON.stringify([
    input.binding.companyId,
    descriptor.kind,
    descriptor.name,
  ]);
  await retryQuarantinedSessionCleanups(cleanupDomain, options.signal);
  if ("runtimeContext" in input) {
    const capabilities = descriptor.runtimeContextCapabilities;
    const unsupported = (["instructions", "skills", "mcp"] as const).filter(
      (key) => capabilities?.[key] !== "native",
    );
    if (unsupported.length)
      throw new Error(
        `native_runtime_context_unsupported: ${descriptor.name} does not natively realize ${unsupported.join(", ")}`,
      );
  }
  let persistedSession = options.existingSession
    ? null
    : (options.persistedSession ??
      (await options.controlPlane.loadSessionCheckpoint?.()) ??
      null);
  if (
    persistedSession &&
    (persistedSession.identity.runId !== input.binding.runId ||
      persistedSession.identity.companyId !== input.binding.companyId ||
      persistedSession.identity.issueId !== input.binding.issueId ||
      persistedSession.identity.agentId !== input.binding.agentId ||
      input.session.normalizedSessionId === null ||
      persistedSession.identity.sessionId !== input.session.normalizedSessionId)
  )
    throw new Error("native_session_checkpoint_binding_mismatch");
  const existingIdentity = options.existingSession?.identity() ?? null;
  if (
    existingIdentity &&
    (existingIdentity.companyId !== input.binding.companyId ||
      existingIdentity.issueId !== input.binding.issueId ||
      existingIdentity.agentId !== input.binding.agentId ||
      input.session.normalizedSessionId === null ||
      existingIdentity.sessionId !== input.session.normalizedSessionId)
  )
    throw new Error("native_session_attach_binding_mismatch");
  const normalizedSessionId =
    persistedSession?.identity.sessionId ??
    existingIdentity?.sessionId ??
    input.session.normalizedSessionId ??
    randomUUID();
  const identity = {
    runId: input.binding.runId,
    sessionId: normalizedSessionId,
    companyId: input.binding.companyId,
    issueId: input.binding.issueId,
    agentId: input.binding.agentId,
  };
  let recovered = false;
  let session: NativeSession | null = null;
  let continuityBreak: {
    reason: string;
    previousDriverSessionId: string;
    previousProviderSessionId: string | null;
  } | null = null;
  let reconciledRecoveryCheckpoint: PersistedNativeSession | null = null;
  if (options.existingSession) {
    if (options.existingSession.attachRun === undefined) {
      throw new Error("native_session_multi_run_unavailable");
    }
    // Attaching can fail even after the retained session's identity passes the
    // static binding check (for example, when the provider lost multi-run
    // state). Prove the provider attachment before opening durable
    // control-plane state because ControlPlanePort has no rollback operation.
    try {
      await options.existingSession.attachRun({ identity });
    } catch (error) {
      // attachRun has no transactional guarantee: a provider may bind the new
      // run before reporting a later failure. Conservatively quarantine the
      // session so neither the old nor partially attached run can reuse it.
      await quarantineRetainedSession(
        options.existingSession,
        options.onSession,
        "native session attachment failed",
        cleanupDomain,
      );
      throw error;
    }
    session = options.existingSession;
    recovered = true;
  } else if (persistedSession) {
    // A persisted checkpoint proves that this is recovery of an existing
    // durable run. Reconcile its cursor and prove provider continuity before
    // re-opening that run in the control plane: ControlPlanePort has no
    // rollback operation if same-session recovery fails.
    const recoveryCheckpoint = persistedSession;
    const recoveryTimeoutMs = options.timeoutMs ?? 900_000;
    persistedSession = await runAbortableOperationWithin({
      timeoutMs: recoveryTimeoutMs,
      timeoutMessage: `native session recovery replay timed out after ${recoveryTimeoutMs}ms`,
      operation: (signal) =>
        reconcileRecoveryCursor({
          controlPlane: options.controlPlane,
          checkpoint: recoveryCheckpoint,
          runId: input.binding.runId,
          sourceInstanceId: options.runnerInstanceId,
          signal,
        }),
    });
    reconciledRecoveryCheckpoint = persistedSession;
    const providerRecoveryCheckpoint = persistedSession;

    const replacementAllowed =
      providerRecoveryCheckpoint.providerRecoveryPolicy ===
      "allow_replacement_after_resume_failure";
    const failedProviderSession =
      providerRecoveryCheckpoint.terminal?.runTerminalState === "failed" &&
      providerRecoveryCheckpoint.semanticResult === null;
    const recovery = failedProviderSession
      ? {
          recovered: false as const,
          reason: "provider session ended with a failed terminal",
        }
      : options.backend.recoverSession
        ? await runAbortableOperationWithin({
            timeoutMs: recoveryTimeoutMs,
            timeoutMessage: `native session provider recovery timed out after ${recoveryTimeoutMs}ms`,
            operation: (signal) =>
              options.backend.recoverSession!(providerRecoveryCheckpoint, {
                signal,
              }),
            onLateResolution: async (lateRecovery) => {
              if (lateRecovery.session) {
                await disposeUnadmittedSession(
                  lateRecovery.session,
                  "native session provider recovery timed out",
                  cleanupDomain,
                );
              }
            },
          })
        : {
            recovered: false as const,
            reason: "driver does not support recovery",
          };
    if (!recovery.recovered || !recovery.session) {
      if (!replacementAllowed) {
        throw new Error(
          `native_session_recovery_failed: ${recovery.reason ?? "unknown"}`,
        );
      }
      continuityBreak = {
        reason: recovery.reason ?? "provider session is no longer recoverable",
        previousDriverSessionId: providerRecoveryCheckpoint.sessionId,
        previousProviderSessionId:
          providerRecoveryCheckpoint.providerSessionId ?? null,
      };
      const replacementInput = {
        identity,
        workingDirectory: input.workspace.cwd,
      };
      session = await runAbortableOperationWithin({
        timeoutMs: recoveryTimeoutMs,
        timeoutMessage: `native session replacement bootstrap timed out after ${recoveryTimeoutMs}ms`,
        operation: (signal) => {
          const abortableReplacementInput = { ...replacementInput, signal };
          return options.backend.openReplacementSession
            ? options.backend.openReplacementSession(
                abortableReplacementInput,
                providerRecoveryCheckpoint,
              )
            : options.backend.openSession(abortableReplacementInput);
        },
        onLateResolution: (lateSession) =>
          disposeUnadmittedSession(
            lateSession,
            "native session replacement bootstrap timed out",
            cleanupDomain,
          ),
      });
    } else {
      session = recovery.session;
      recovered = true;
    }
  }
  if (session === null) {
    // A fresh provider session is part of admission. Prove that it exists
    // before opening durable run state because ControlPlanePort intentionally
    // exposes no rollback for an admitted run.
    const bootstrapTimeoutMs = options.timeoutMs ?? 900_000;
    const bootstrapInput = {
      identity,
      workingDirectory: input.workspace.cwd,
    };
    session = await runAbortableOperationWithin({
      timeoutMs: bootstrapTimeoutMs,
      timeoutMessage: `native session bootstrap timed out after ${bootstrapTimeoutMs}ms`,
      operation: (signal) =>
        options.backend.openSession({
          ...bootstrapInput,
          signal,
        }),
      onLateResolution: (lateSession) =>
        disposeUnadmittedSession(
          lateSession,
          "native session bootstrap timed out",
          cleanupDomain,
        ),
    });
  }
  try {
    await options.controlPlane.openRun({
      identity,
      backendKind: descriptor.kind,
      sourceInstanceId: options.runnerInstanceId,
    });
  } catch (error) {
    if (session) {
      // Attachment and recovery both establish provider-side authority before
      // durable admission. If admission then fails, the prepared session must
      // not remain available for reuse.
      await quarantineRetainedSession(
        session,
        options.onSession,
        "native control-plane run admission failed",
        cleanupDomain,
      );
    }
    throw error;
  }
  let sessionClosePromise: Promise<void> | null = null;
  let sessionQuarantined = false;
  const quarantineSession = () => {
    if (sessionQuarantined) return;
    sessionQuarantined = true;
    try {
      options.onSession?.(null);
    } catch {
      // Owner notification cannot prevent provider cleanup.
    }
  };
  let failedCleanupDeferred = false;
  let sessionCloseRecoveryPromise: Promise<void> | null = null;
  const retainFailedCleanup = (cleanup: Promise<void>) => {
    failedCleanupDeferred = true;
    quarantineSession();
    retainFailedSessionCleanupOwner(cleanup, cleanupDomain);
  };
  const startSessionClose = (reason: string) => {
    const attempt = session.close({ reason });
    sessionClosePromise = attempt;
    return attempt;
  };
  const closeSession = () => {
    if (sessionClosePromise === null) {
      quarantineSession();
      const firstAttempt = startSessionClose(
        "native session execution complete",
      );
      // Preserve the first close outcome for its caller. If an exact attempt
      // fails, retain one ordered, delay-bounded production recovery within a
      // finite retry budget. A still-pending attempt is never overlapped or
      // replaced, and repeated terminal failure cannot create an immortal loop.
      const recovery = (async () => {
        let attempt = firstAttempt;
        let retryCount = 0;
        while (true) {
          try {
            await attempt;
            return;
          } catch (error) {
            if (retryCount >= MAX_FAILED_SESSION_CLOSE_RETRIES) {
              quarantineSessionCleanup(session, cleanupDomain);
              throw error;
            }
            retryCount += 1;
            await waitForSessionCloseRetry();
            if (sessionClosePromise === attempt) {
              sessionClosePromise = null;
            }
            attempt = startSessionClose(
              `native session cleanup recovery after close failure (${retryCount})`,
            );
          }
        }
      })();
      sessionCloseRecoveryPromise = recovery;
      retainFailedCleanup(recovery);
      void recovery
        .finally(() => {
          if (sessionCloseRecoveryPromise === recovery) {
            sessionCloseRecoveryPromise = null;
          }
        })
        .catch(() => undefined);
    }
    const activeClose = sessionClosePromise;
    if (activeClose === null) {
      throw new Error("native session cleanup lost its active close attempt");
    }
    return activeClose;
  };
  let executionSucceeded = false;
  try {
    // Ownership publication is part of the execution-owned lifetime. If the
    // callback fails, the finally block below still quarantines and closes the
    // provider session.
    options.onSession?.(session);
    const checkpointTimeoutMs =
      options.checkpointTimeoutMs ?? DEFAULT_NATIVE_CHECKPOINT_TIMEOUT_MS;
    const persistCheckpoint = (
      snapshot: PersistedNativeSession,
      externalSignal?: AbortSignal,
    ) =>
      persistCheckpointWithin({
        snapshot,
        controlPlane: options.controlPlane,
        onCheckpoint: options.onCheckpoint,
        timeoutMs: checkpointTimeoutMs,
        externalSignal,
      });
    // Cursor reconciliation is provisional until both provider recovery and
    // durable run admission succeed. Persist it only after those boundaries;
    // the execution-owned finally below quarantines the recovered session if
    // checkpoint persistence itself fails.
    if (reconciledRecoveryCheckpoint !== null) {
      await persistCheckpoint(reconciledRecoveryCheckpoint);
    }
    const checkpoint = async (signal?: AbortSignal) => {
      const snapshot = await session.snapshot(signal ? { signal } : undefined);
      signal?.throwIfAborted();
      await persistCheckpoint(snapshot, signal);
    };
    const recoveredSnapshot = await session.snapshot();
    const recoveredActiveTurnId = recovered
      ? (recoveredSnapshot.activeTurnId ?? null)
      : (persistedSession?.activeTurnId ?? null);
    const adoptedDispositionTerminal = Boolean(
      recovered &&
      recoveredSnapshot.dispositionOnlyRecoveryConsumed &&
      !recoveredActiveTurnId &&
      (recoveredSnapshot.terminalTurns?.length ?? 0) >
        (persistedSession?.terminalTurns?.length ?? 0),
    );
    if (continuityBreak) {
      await options.onContinuityBreak?.({
        ...continuityBreak,
        replacementDriverSessionId: recoveredSnapshot.sessionId,
        replacementProviderSessionId:
          recoveredSnapshot.providerSessionId ?? null,
      });
    }
    // recoverSession may adopt a provider terminal and enqueue its normalized
    // event before returning. Do not checkpoint that terminal fingerprint
    // until consumeTurn has durably appended the event: if this process dies
    // first, retaining the older checkpoint lets the next recovery adopt and
    // emit the same provider terminal again instead of reconstructing a closed
    // session with no event to finalize.
    if (!adoptedDispositionTerminal) {
      await persistCheckpoint(recoveredSnapshot);
    }

    let consumed = {
      event: null as PrpEvent | null,
      eventCount: 0,
      highestContiguousSourceSeq: 0,
      governedResult: null as PrpStructuredRunResult | null,
    };
    const completionSnapshot =
      recoveredSnapshot.semanticResult && recoveredSnapshot.terminal
        ? recoveredSnapshot
        : persistedSession;
    let completed =
      completionSnapshot?.semanticResult && completionSnapshot.terminal
        ? {
            result: completionSnapshot.semanticResult,
            terminal: completionSnapshot.terminal,
            turnId:
              completionSnapshot.activeTurnId ??
              completedSemanticResultTurnId(completionSnapshot),
          }
        : null;
    if (!completed) {
      // A recovered driver is authoritative about whether a provider turn is
      // still active. In particular, drivers normalize the checkpoint race
      // where a terminal fingerprint was persisted before activeTurnId was
      // cleared. Falling back to the older control-plane checkpoint here
      // resurrects that terminal turn and waits forever for an event that was
      // already consumed.
      const dispositionRecoveryWasSubmitted = Boolean(
        recovered &&
        persistedSession?.dispositionOnlyRecoveryConsumed &&
        !recoveredSnapshot.semanticResult &&
        !recoveredActiveTurnId,
      );
      const dispositionRecoveryTurnId =
        persistedSession?.dispositionOnlyRecoveryTurnId ??
        recoveredSnapshot.dispositionOnlyRecoveryTurnId ??
        null;
      const recoveredDispositionTurnObserved = Boolean(
        dispositionRecoveryTurnId &&
        recoveredSnapshot.terminalTurns?.some(
          (terminal) => terminal.turnId === dispositionRecoveryTurnId,
        ),
      );
      const dispositionRecoveryStillOwned = Boolean(
        dispositionRecoveryWasSubmitted &&
        recoveredSnapshot.dispositionOnlyRecoveryConsumed &&
        dispositionRecoveryTurnId !== null &&
        recoveredDispositionTurnObserved,
      );
      const replayedDisposition =
        dispositionRecoveryWasSubmitted && dispositionRecoveryTurnId !== null
          ? await replayCheckpointedTurnTerminal({
              controlPlane: options.controlPlane,
              runId: input.binding.runId,
              sourceInstanceId: options.runnerInstanceId,
              priorTerminalTurnIds: (persistedSession?.terminalTurns ?? []).map(
                (terminal) => terminal.turnId,
              ),
              expectedTurnId: dispositionRecoveryTurnId,
            })
          : null;
      // Durable replay remains authoritative. If it has no terminal, an exact
      // consumed marker bound to the same terminal fingerprint in both
      // checkpoints proves provider completion without reconstructing provider
      // output. Give only that non-provider fact to control-plane policy; a
      // mismatch fails closed and a null policy result fails finalization.
      const dispositionFallback =
        dispositionRecoveryWasSubmitted &&
        replayedDisposition === null &&
        persistedSession
          ? checkpointedResultlessDispositionFallback({
              persisted: persistedSession,
              recovered: recoveredSnapshot,
              controlPlaneInstanceId: options.controlPlaneInstanceId,
            })
          : null;
      const checkpointedDispositionTerminal =
        replayedDisposition !== null || dispositionFallback !== null;
      const recoveryTerminal =
        replayedDisposition?.terminal ?? dispositionFallback;
      const consumptionAbort = new AbortController();
      const consuming =
        recoveryTerminal === null
          ? consumeTurn(
              session,
              options.controlPlane,
              options.timeoutMs ?? 900_000,
              options.runtimeInputLiveWindowMs ??
                DEFAULT_NATIVE_RUNTIME_INPUT_LIVE_WINDOW_MS,
              options.semanticResultTerminalGraceMs ??
                DEFAULT_NATIVE_SEMANTIC_RESULT_TERMINAL_GRACE_MS,
              closeSession,
              quarantineSession,
              options.resolveGovernedWait,
              consumptionAbort.signal,
            )
          : Promise.resolve({
              event: recoveryTerminal,
              eventCount: 0,
              highestContiguousSourceSeq:
                replayedDisposition === null ? 0 : recoveryTerminal.sourceSeq,
              governedResult: null,
            });
      // Event consumption must begin before startTurn so an eager provider cannot
      // outrun us. Observe its rejection immediately, though: if startTurn or
      // checkpointing fails first, the outer finally closes the session and the
      // abandoned consumer will reject when its stream closes. Without a handler
      // that later rejection becomes process-fatal under Node's strict policy.
      void consuming.catch(() => undefined);
      try {
        if (
          !recovered ||
          (!recoveredActiveTurnId &&
            !adoptedDispositionTerminal &&
            !checkpointedDispositionTerminal &&
            !dispositionRecoveryStillOwned)
        ) {
          const modelEnvelope = buildNativeModelEnvelope(input);
          const dispositionOnlyRecovery = Boolean(
            recovered &&
            !recoveredSnapshot.semanticResult &&
            (persistedSession?.terminalTurns?.length ?? 0) > 0 &&
            !recoveredActiveTurnId,
          );
          const effectFreeInitialAcpxTurn =
            dispositionOnlyRecovery && persistedSession
              ? await replayProvesEffectFreeInitialAcpxTurn({
                  controlPlane: options.controlPlane,
                  checkpoint: persistedSession,
                  runId: input.binding.runId,
                  sourceInstanceId: options.runnerInstanceId,
                })
              : false;
          if (dispositionOnlyRecovery && !effectFreeInitialAcpxTurn) {
            modelEnvelope.task.prompt = [
              "Paperclip semantic-result recovery for a prior completed provider turn.",
              "The prior turn already performed the work and its user-facing final answer is recorded.",
              "Do not repeat implementation, tests, research, or the final answer.",
              "Use the existing session context to invoke exactly one paperclip_finish or paperclip_block with the accurate current disposition, then stop without additional user-facing prose.",
            ].join("\n");
          }
          await session.startTurn({
            message: { role: "user", text: JSON.stringify(modelEnvelope) },
            requestedCollaborationMode:
              "executionMode" in input ? input.executionMode : "default",
          });
          await checkpoint();
        }
      } catch (error) {
        // Consumption starts before provider launch so eager events cannot be
        // lost. If launch or its checkpoint fails, abort any in-flight append
        // before joining cleanup so the failed turn cannot commit late or
        // strand execution on a never-settling durability call.
        consumptionAbort.abort(error);
        await consuming.catch(() => undefined);
        throw error;
      }
      const terminalEvent = await consuming;
      consumed = terminalEvent;
    }
    const finalizationTimeoutMs = options.timeoutMs ?? 900_000;
    const preparedFinalization = await finalizeWithin({
      timeoutMs: finalizationTimeoutMs,
      operation: async (signal) => {
        let settledCompletion = completed;
        if (settledCompletion === null) {
          const terminalEvent = consumed.event;
          if (terminalEvent === null) {
            throw new Error(
              "native_finalization_missing: session returned no terminal event",
            );
          }
          settledCompletion =
            consumed.governedResult === null
              ? await session.result()
              : {
                  result: consumed.governedResult,
                  terminal: {
                    schema: "paperclip.prp.terminal.v1",
                    turnTerminalState: "completed",
                    runTerminalState: "succeeded",
                    reportedWorkDisposition:
                      consumed.governedResult.reportedWorkDisposition,
                  },
                  turnId: terminalEvent.turnId ?? null,
                };
          signal.throwIfAborted();
          if (settledCompletion === null && options.resolveMissingResult) {
            const recoveredResult = await options.resolveMissingResult({
              turnId: terminalEvent.turnId ?? null,
              terminalEvent,
            });
            signal.throwIfAborted();
            if (recoveredResult !== null) {
              settledCompletion = {
                result: recoveredResult,
                terminal: terminalFromEvent(
                  terminalEvent,
                  recoveredResult.reportedWorkDisposition,
                ),
                turnId: terminalEvent.turnId ?? null,
              };
            }
          }
          // Do not publish the resolved result to the retryable phase until its
          // checkpoint has settled. A timed-out checkpoint therefore cannot be
          // skipped by a second attempt.
          await checkpoint(signal);
          signal.throwIfAborted();
          completed = settledCompletion;
        }
        if (settledCompletion === null) {
          throw new Error(
            "native_finalization_missing: session returned no semantic result",
          );
        }
        let terminal: PrpTerminalState;
        if (consumed.governedResult !== null) {
          terminal = settledCompletion.terminal;
        } else if (
          completionSnapshot?.semanticResult &&
          completionSnapshot.terminal
        ) {
          terminal = completionSnapshot.terminal;
        } else {
          terminal = terminalFromEvent(
            consumed.event!,
            settledCompletion.result.reportedWorkDisposition,
          );
        }
        const eventTurnId =
          settledCompletion.turnId ??
          persistedSession?.activeTurnId ??
          persistedSession?.terminalTurns?.at(-1)?.turnId ??
          consumed.event?.turnId;
        const controlEvent = (
          sourceSeq: number,
          eventType: PrpEvent["eventType"],
          payload: Record<string, unknown>,
        ): PrpEvent => ({
          schema: "paperclip.prp.event.v1",
          sourceEventId: `${options.controlPlaneInstanceId}:${input.binding.runId}:${sourceSeq}`,
          sourceSeq,
          sourceInstanceId: options.controlPlaneInstanceId,
          sourceKind: "control_plane",
          runId: input.binding.runId,
          normalizedSessionId,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
          eventType,
          schemaVersion: 1,
          priority: 0,
          emittedAt: new Date().toISOString(),
          payload,
        });
        return {
          completed: settledCompletion,
          terminal,
          expectedControlEvents: [
            controlEvent(1, "run.result.accepted", {
              result: settledCompletion.result,
            }),
            controlEvent(
              2,
              "run.terminal",
              terminal as unknown as Record<string, unknown>,
            ),
          ],
        };
      },
    });
    const baselineControlEventSequences = new Set<number>();
    const accountedControlEventSequences = new Set<number>();
    let baselineControlReplayCaptured = false;
    const durableExecutionResult = await finalizeIdempotentControlPlaneWithin({
      timeoutMs: finalizationTimeoutMs,
      operation: async (signal) => {
        const controlReplay = await options.controlPlane.replayEvents(
          {
            runId: input.binding.runId,
            sourceInstanceId: options.controlPlaneInstanceId,
            afterSourceSeq: 0,
            limit: 10,
          },
          { signal },
        );
        signal.throwIfAborted();
        const replayBySequence = new Map(
          controlReplay.events.map((event) => [event.sourceSeq, event]),
        );
        for (const existing of controlReplay.events) {
          const expected =
            preparedFinalization.expectedControlEvents[existing.sourceSeq - 1];
          if (
            expected === undefined ||
            existing.eventType !== expected.eventType ||
            canonicalJson(existing.payload) !== canonicalJson(expected.payload)
          ) {
            throw new Error(
              `native_control_event_replay_conflict:${existing.sourceSeq}`,
            );
          }
        }
        if (!baselineControlReplayCaptured) {
          for (const existing of controlReplay.events) {
            baselineControlEventSequences.add(existing.sourceSeq);
          }
          baselineControlReplayCaptured = true;
        } else {
          for (const existing of controlReplay.events) {
            if (
              !baselineControlEventSequences.has(existing.sourceSeq) &&
              !accountedControlEventSequences.has(existing.sourceSeq)
            ) {
              accountedControlEventSequences.add(existing.sourceSeq);
              consumed.eventCount += 1;
            }
          }
        }
        consumed.highestContiguousSourceSeq = Math.max(
          consumed.highestContiguousSourceSeq,
          controlReplay.highestContiguousSourceSeq,
        );
        for (const event of preparedFinalization.expectedControlEvents) {
          if (replayBySequence.has(event.sourceSeq)) continue;
          const receipt = await options.controlPlane.appendEvent(event, {
            signal,
          });
          signal.throwIfAborted();
          if (
            receipt.disposition === "committed" &&
            !accountedControlEventSequences.has(event.sourceSeq)
          ) {
            accountedControlEventSequences.add(event.sourceSeq);
            consumed.eventCount += 1;
          }
          consumed.highestContiguousSourceSeq = Math.max(
            consumed.highestContiguousSourceSeq,
            receipt.highestContiguousSourceSeq,
          );
        }
        await options.controlPlane.completeRun(
          {
            result: preparedFinalization.completed.result,
            terminal: preparedFinalization.terminal,
            turnId: preparedFinalization.completed.turnId,
            callerResultId: `${options.runnerInstanceId}:${input.binding.runId}:result`,
            callerDedupeKey: `${input.binding.runId}:${input.completionContract.sha256}`,
          },
          { signal },
        );
        return {
          result: preparedFinalization.completed.result,
          terminal: preparedFinalization.terminal,
          turnId: preparedFinalization.completed.turnId,
          normalizedSessionId,
          driverKind: descriptor.name,
          nativeEventCount: consumed.eventCount,
          highestContiguousSourceSeq: consumed.highestContiguousSourceSeq,
        };
      },
    });
    let enrichment: {
      providerSessionId: string | null;
      driverVersion: string;
      usage: Record<string, unknown> | null;
    };
    try {
      enrichment = await finalizeWithin({
        timeoutMs: options.timeoutMs ?? 900_000,
        operation: async (signal) => {
          const snapshot = await session.snapshot({ signal });
          signal.throwIfAborted();
          const completedSnapshot = {
            ...snapshot,
            semanticResult: durableExecutionResult.result,
            terminal: durableExecutionResult.terminal,
          };
          await persistCheckpoint(completedSnapshot, signal);
          signal.throwIfAborted();
          const usage = (await session.usage?.()) ?? null;
          signal.throwIfAborted();
          return {
            providerSessionId: snapshot.providerSessionId ?? null,
            driverVersion:
              typeof usage?.driverVersion === "string"
                ? usage.driverVersion
                : descriptor.version,
            usage,
          };
        },
      });
    } catch {
      // completeRun is the durable commit boundary. Snapshot/checkpoint/usage
      // enrichment cannot revoke that success, but a session whose final
      // checkpoint is unknown must not remain available for reuse.
      void closeSession().catch(() => undefined);
      enrichment = {
        providerSessionId: recoveredSnapshot.providerSessionId ?? null,
        driverVersion: descriptor.version,
        usage: null,
      };
    }
    executionSucceeded = true;
    return { ...durableExecutionResult, ...enrichment };
  } finally {
    const shouldClose =
      !options.keepSessionOpen || !executionSucceeded || sessionQuarantined;
    if (shouldClose && options.requireSessionCloseBeforeReturn) {
      if (!failedCleanupDeferred) closeSession();
      // A remote runner close owns its suspension and verified checkpoint.
      // Its implementation is finite, and the host must not release the
      // environment until the complete close/retry owner has settled.
      const requiredClose = sessionCloseRecoveryPromise ?? sessionClosePromise;
      if (requiredClose !== null) {
        // Unlike ordinary provider cleanup, this close owns required remote
        // checkpoint persistence. Exhausting its bounded recovery must fail
        // the execution instead of converting the rejection into success.
        await requiredClose;
      }
    } else if (shouldClose && !failedCleanupDeferred) {
      // A provider that ignores close must not keep execution pending forever.
      // closeSession removes it from the caller before invoking the backend;
      // retain observation of the promise, but bound the final join. Provider
      // cleanup cannot reverse a result the control plane already committed;
      // after that durable boundary the session remains unavailable for reuse
      // and late close rejection stays observed without contradicting success.
      await settlesWithin(
        Promise.allSettled([closeSession()]),
        FAILED_OPERATION_SETTLEMENT_GRACE_MS,
      );
    }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function completedSemanticResultTurnId(
  snapshot: PersistedNativeSession,
): string | null {
  if (
    snapshot.semanticResult === undefined ||
    snapshot.semanticResult === null
  ) {
    return null;
  }
  const semanticFingerprint = canonicalJson(snapshot.semanticResult);
  for (const terminal of [...(snapshot.terminalTurns ?? [])].reverse()) {
    try {
      const value: unknown = JSON.parse(terminal.fingerprint);
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).status === "completed" &&
        (value as Record<string, unknown>).semanticResult ===
          semanticFingerprint
      ) {
        return terminal.turnId;
      }
    } catch {
      // Legacy terminal fingerprints cannot prove semantic-result ownership.
    }
  }
  return null;
}
