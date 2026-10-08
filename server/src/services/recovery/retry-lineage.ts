export function sanitizeRetryOfRunId(input: {
  runId: string;
  retryOfRunId: string | null | undefined;
}) {
  if (!input.retryOfRunId || input.retryOfRunId === input.runId) return null;
  return input.retryOfRunId;
}
