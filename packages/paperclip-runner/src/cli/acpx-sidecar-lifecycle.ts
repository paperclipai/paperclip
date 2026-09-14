export interface OpenedAcpxSidecarHost {
  identity(): unknown;
  status(): Promise<unknown>;
  close(options: { reason: string }): Promise<void>;
}

const FAILED_ADMISSION_CLOSE_TIMEOUT_MS = 8_000;
const ACTIVE_HOST_CLEANUP_ATTEMPTS = 4;

class AcpxSidecarStatusReadTimeoutError extends Error {
  readonly code = "ACPX_SIDECAR_STATUS_READ_TIMEOUT";

  constructor() {
    super("ACPX session status read exceeded its timeout");
    this.name = "AcpxSidecarStatusReadTimeoutError";
  }
}

export function hasSidecarSessionOwnership(
  host: unknown,
  activeHostCleanup: Promise<void> | null,
  failedAdmissionCleanup: Promise<void> | null,
): boolean {
  return Boolean(host || activeHostCleanup || failedAdmissionCleanup);
}

/**
 * Ordinary commands cannot observe a host while cleanup owns it. An explicit
 * cleanup retry may reuse that same host so its close can supersede a stale
 * owner; admission remains guarded separately by hasSidecarSessionOwnership.
 */
export function requireSidecarCommandHost<T>(
  host: T | null,
  activeHostCleanup: Promise<void> | null,
  options: { allowCleanupRetry?: boolean } = {},
): T {
  if (!host) throw new Error("ACPX session is not open");
  if (activeHostCleanup && options.allowCleanupRetry !== true) {
    throw new Error("ACPX session cleanup is in progress");
  }
  return host;
}

export async function readSidecarHostStatusWithin(
  host: Pick<OpenedAcpxSidecarHost, "status">,
  timeoutMs = FAILED_ADMISSION_CLOSE_TIMEOUT_MS,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      host.status(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new AcpxSidecarStatusReadTimeoutError()),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function awaitSidecarCleanupWithin(
  cleanup: Promise<void>,
  timeoutMs = FAILED_ADMISSION_CLOSE_TIMEOUT_MS,
): Promise<"settled" | "deferred"> {
  const outcome = await observeSidecarCleanupWithin(cleanup, timeoutMs);
  return outcome.status === "deferred" ? "deferred" : "settled";
}

export type SidecarCleanupOutcome =
  | { status: "settled" }
  | { status: "deferred" }
  | { status: "failed"; error: unknown };

export async function observeSidecarCleanupWithin(
  cleanup: Promise<void>,
  timeoutMs = FAILED_ADMISSION_CLOSE_TIMEOUT_MS,
): Promise<SidecarCleanupOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      cleanup.then(
        () => ({ status: "settled" as const }),
        (error: unknown) => ({ status: "failed" as const, error }),
      ),
      new Promise<SidecarCleanupOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ status: "deferred" }), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function combineSidecarAdmissionCleanups(
  cleanups: readonly Promise<void>[],
): Promise<void> {
  const outcomes = await Promise.allSettled(cleanups);
  const errors = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason as unknown] : [],
  );
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "ACPX failed-admission cleanup did not release provider ownership",
    );
  }
}

/**
 * Keep ownership until every cleanup started for the same host settles. Once
 * all observers are terminal, one successful close proves that host released
 * its provider resources; an intermediate coalesced rejection must not erase
 * that proof. Reject only when every cleanup owner failed.
 */
export async function combineSidecarHostCleanups(
  cleanups: readonly [Promise<void>, Promise<void>],
): Promise<void> {
  const outcomes = await Promise.allSettled(cleanups);
  if (outcomes.some((outcome) => outcome.status === "fulfilled")) return;
  const errors = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason as unknown] : [],
  );
  throw new AggregateError(
    errors,
    "ACPX active-host cleanup did not release provider ownership",
  );
}

export function recoverAndCombineSidecarHostCleanup(
  host: Pick<OpenedAcpxSidecarHost, "close">,
  cleanup: Promise<void>,
  prior: Promise<void> | null,
): Promise<void> {
  const recovered = recoverSidecarHostCleanup(host, cleanup);
  return prior ? combineSidecarHostCleanups([prior, recovered]) : recovered;
}

export function reportAuthoritativeSidecarHostCleanupFailure(
  closing: boolean,
  activeCleanup: Promise<void> | null,
  failedCleanup: Promise<void>,
  error: unknown,
  reportFailure: (error: unknown) => void,
): void {
  if (!closing && activeCleanup === failedCleanup) reportFailure(error);
}

export async function closeActiveSidecarHostWithin(
  host: Pick<OpenedAcpxSidecarHost, "close">,
  reason: string,
  timeoutMs = FAILED_ADMISSION_CLOSE_TIMEOUT_MS,
  retainCleanup: (cleanup: Promise<void>) => void = () => undefined,
): Promise<"settled" | "deferred"> {
  const cleanup = host.close({ reason });
  retainCleanup(cleanup);
  return await awaitSidecarCleanupWithin(cleanup, timeoutMs);
}

export async function closeSidecarHostForCommand(
  host: Pick<OpenedAcpxSidecarHost, "close">,
  reason: string,
  timeoutMs = FAILED_ADMISSION_CLOSE_TIMEOUT_MS,
  retainCleanup: (cleanup: Promise<void>) => void = () => undefined,
): Promise<void> {
  const cleanup = host.close({ reason });
  retainCleanup(cleanup);
  const disposition = await awaitSidecarCleanupWithin(cleanup, timeoutMs);
  if (disposition === "deferred") {
    throw new Error("ACPX session cleanup exceeded its command timeout");
  }
  // The bounded wait only reports settlement; preserve the exact close error
  // for the command response and keep the host available for a later retry.
  await cleanup;
}

export async function recoverSidecarHostCleanup(
  host: Pick<OpenedAcpxSidecarHost, "close">,
  initialCleanup: Promise<void>,
  maxAttempts = ACTIVE_HOST_CLEANUP_ATTEMPTS,
): Promise<void> {
  let cleanup = initialCleanup;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await cleanup;
      return;
    } catch (error) {
      if (attempt >= maxAttempts) throw error;
      // AcpxRuntimeHost releases its failed close promise before propagating
      // the rejection, so this starts a new sequential cleanup attempt rather
      // than reusing or overlapping the rejected operation.
      cleanup = host.close({ reason: "Paperclip cleanup recovery" });
    }
  }
}

export async function verifyOpenedAcpxSidecarHost(
  host: OpenedAcpxSidecarHost,
  sanitizeStatus: (value: unknown) => Record<string, unknown>,
  closeTimeoutMs = FAILED_ADMISSION_CLOSE_TIMEOUT_MS,
  retainCleanup: (cleanup: Promise<void>) => void = () => undefined,
): Promise<{ identity: unknown; status: Record<string, unknown> }> {
  try {
    const identity = host.identity();
    const status = sanitizeStatus(
      await readSidecarHostStatusWithin(host, closeTimeoutMs),
    );
    return { identity, status };
  } catch (error) {
    const cleanup = host.close({
      reason: "ACPX session open verification failed",
    });
    // The admission timeout bounds the command response, not ownership. The
    // sidecar retains this exact close operation so shutdown can still await
    // provider termination after the bounded verification path returns.
    retainCleanup(cleanup);
    const cleanupError = await boundedFailedAdmissionClose(
      cleanup,
      closeTimeoutMs,
    );
    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "ACPX session verification and provider cleanup failed",
      );
    }
    throw error;
  }
}

async function boundedFailedAdmissionClose(
  close: Promise<void>,
  timeoutMs: number,
): Promise<unknown | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      close.then(
        () => null,
        (error: unknown) => error,
      ),
      new Promise<Error>((resolve) => {
        timer = setTimeout(
          () =>
            resolve(
              new Error(
                "ACPX failed-admission cleanup exceeded its shutdown timeout",
              ),
            ),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface AcpxRunAttachment {
  runId: string;
  catalogRevision: number;
}

export function parseAcpxRunAttachment(
  params: Record<string, unknown>,
): AcpxRunAttachment {
  return {
    runId: boundedIdentity(params.runId, "runId"),
    catalogRevision: positiveInteger(params.catalogRevision, "catalogRevision"),
  };
}

export function boundedIdentity(value: unknown, field: string): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new Error(`${field} is required`);
  if (result.length > 240 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error(`${field} is invalid`);
  }
  return result;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return Number(value);
}
