import type { RunnerE2EResult } from "./types.js";

export interface ResultExitGuard {
  enabled: boolean;
  poll: () => Promise<void>;
}

export function createResultExitGuard(input: {
  resultPaths: readonly string[];
  interactive: boolean;
  graceMs: number;
  now: () => number;
  pathExists: (path: string) => Promise<boolean>;
  onExpired: () => Promise<void> | void;
}): ResultExitGuard {
  const enabled = !input.interactive && input.resultPaths.length > 0;
  let completionObservedAt: number | null = null;
  let pollActive = false;
  let expired = false;

  return {
    enabled,
    async poll() {
      if (!enabled || pollActive || expired) return;
      pollActive = true;
      try {
        const complete = (
          await Promise.all(input.resultPaths.map(input.pathExists))
        ).every(Boolean);
        if (!complete) return;
        const now = input.now();
        completionObservedAt ??= now;
        if (now - completionObservedAt < input.graceMs) return;
        expired = true;
        await input.onExpired();
      } finally {
        pollActive = false;
      }
    },
  };
}

export function enforceResultProcessIntegrity(
  result: RunnerE2EResult,
  processResult: {
    exitCode: number;
    timedOut: boolean;
    postResultStallError: string | null;
    processCleanupError: string | null;
  },
): RunnerE2EResult {
  const integrityError =
    processResult.processCleanupError ??
    processResult.postResultStallError ??
    (processResult.timedOut && result.status === "passed"
      ? "Playwright exceeded its process watchdog after writing every result"
      : processResult.exitCode !== 0 && result.status === "passed"
        ? `Playwright exited ${processResult.exitCode} after writing a passing result`
        : null);
  return integrityError
    ? {
        ...result,
        status: "failed",
        failureClass: "cleanup_failure",
        error: integrityError,
        cleanup: "failed",
      }
    : result;
}
