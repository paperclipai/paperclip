import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import { classifyBobError, describeBobFailure, shouldRetry, isSessionError } from "./error-detection.js";
import type { BobStreamResult } from "./parse-stdout.js";

/**
 * Result of a single Bob Shell execution attempt.
 */
export interface BobAttemptResult {
  /** Process execution result */
  proc: RunProcessResult;
  /** Parsed Bob Shell output */
  parsed: BobStreamResult;
}

/**
 * Configuration for retry strategy.
 */
export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Base delay between retries in milliseconds */
  retryDelayMs: number;
}

/**
 * Logging callback for retry operations.
 */
export type RetryLogger = (stream: "stdout" | "stderr", message: string) => Promise<void>;

/**
 * Executes a Bob Shell run with automatic retry on transient failures.
 * 
 * Implements exponential backoff retry strategy for transient errors like
 * network failures or temporary resource unavailability. Non-retryable errors
 * (configuration issues, authentication failures) fail immediately.
 * 
 * @param runAttempt - Function that executes a single attempt
 * @param config - Retry configuration
 * @param onLog - Logging callback
 * @param sessionId - Current session ID (null for new session)
 * @returns Final attempt result after retries
 * 
 * @example
 * ```typescript
 * const result = await executeWithRetry(
 *   (sid) => runBobShell(sid, prompt),
 *   { maxRetries: 2, retryDelayMs: 1000 },
 *   async (stream, msg) => console.log(msg),
 *   "session-123"
 * );
 * ```
 */
export async function executeWithRetry(
  runAttempt: (sessionId: string | null) => Promise<BobAttemptResult>,
  config: RetryConfig,
  onLog: RetryLogger,
  sessionId: string | null,
): Promise<BobAttemptResult> {
  const { maxRetries, retryDelayMs } = config;

  let currentAttempt = await runAttempt(sessionId);
  let attemptNumber = 1;

  while (
    attemptNumber <= maxRetries &&
    !currentAttempt.proc.timedOut &&
    (currentAttempt.proc.exitCode ?? 0) !== 0
  ) {
    const errorClassification = classifyBobError({
      exitCode: currentAttempt.proc.exitCode,
      signal: currentAttempt.proc.signal,
      timedOut: currentAttempt.proc.timedOut,
      stdout: currentAttempt.proc.stdout,
      stderr: currentAttempt.proc.stderr,
    });

    // Check if we should retry
    if (!shouldRetry(errorClassification, attemptNumber, maxRetries)) {
      // Log detailed error information for non-retryable errors
      const failureDescription = describeBobFailure({
        exitCode: currentAttempt.proc.exitCode,
        signal: currentAttempt.proc.signal,
        timedOut: currentAttempt.proc.timedOut,
        stdout: currentAttempt.proc.stdout,
        stderr: currentAttempt.proc.stderr,
      });
      await onLog("stderr", `[paperclip] ${failureDescription}\n`);
      break;
    }

    // Calculate delay with exponential backoff
    const delay = retryDelayMs * Math.pow(2, attemptNumber - 1);

    await onLog(
      "stdout",
      `[paperclip] ${errorClassification.message}; retrying in ${delay}ms (attempt ${attemptNumber + 1}/${maxRetries + 1}).\n`,
    );

    // Wait before retry
    await new Promise((resolve) => setTimeout(resolve, delay));

    // Retry with fresh session for session errors, otherwise retry with same session
    const retrySessionId = isSessionError(errorClassification) ? null : sessionId;
    currentAttempt = await runAttempt(retrySessionId);
    attemptNumber++;
  }

  return currentAttempt;
}