import { shouldRetryFailure } from "./failure-classifier.js";
import type { FailureClass, RunnerTaskFixture } from "./types.js";

type RetryTask = Pick<RunnerTaskFixture, "automaticRetryPolicy">;
interface RetryableAttempt { status: "passed" | "failed"; failureClass?: FailureClass }
interface RetryOptions { maxAutomaticRetries: number; ui: boolean; debug: boolean }

export function effectiveAutomaticRetryLimit(task: RetryTask, configuredLimit: number): number {
  return task.automaticRetryPolicy === "single_attempt" ? 0 : configuredLimit;
}

/** Keep the original failed result when the fixture admits exactly one attempt. */
export async function executeWithAutomaticRetry<Result extends RetryableAttempt>(input: {
  task: RetryTask;
  options: RetryOptions;
  qualificationCandidate: boolean;
  runAttempt(attempt: 1 | 2): Promise<Result>;
  cancelled(): boolean;
  onRetry(result: Result): void;
}): Promise<Result> {
  const firstResult = await input.runAttempt(1);
  if (input.qualificationCandidate || input.options.ui || input.options.debug ||
      firstResult.status !== "failed" || !firstResult.failureClass ||
      !shouldRetryFailure(firstResult.failureClass,
        effectiveAutomaticRetryLimit(input.task, input.options.maxAutomaticRetries))) return firstResult;
  if (input.cancelled()) throw new Error("Runner E2E campaign cancelled");
  input.onRetry(firstResult);
  return input.runAttempt(2);
}
