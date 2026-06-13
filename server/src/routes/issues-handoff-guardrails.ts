const MS_PER_SECOND = 1000;

export const STALE_HANDOFF_THRESHOLD_MS = 30 * MS_PER_SECOND;

export function assignmentToCheckoutLatencyMs(input: {
  createdAt: Date;
  startedAt: Date;
}): number {
  return Math.max(0, input.startedAt.getTime() - input.createdAt.getTime());
}

export function isStaleHandoffLatency(
  latencyMs: number,
  thresholdMs: number = STALE_HANDOFF_THRESHOLD_MS,
): boolean {
  return latencyMs >= thresholdMs;
}

function formatDurationSeconds(ms: number): string {
  return (ms / MS_PER_SECOND).toFixed(3);
}

export function buildStaleHandoffGuardrailComment(input: {
  issueIdentifier: string | null;
  latencyMs: number;
  thresholdMs: number;
}): string {
  const issueRef = input.issueIdentifier ?? "(identifier unavailable)";
  return [
    "## Guardrail Alert: Stale Handoff Detected",
    "",
    `Issue ${issueRef} crossed assignment->checkout latency threshold.`,
    "",
    `- Assignment->checkout latency: ${formatDurationSeconds(input.latencyMs)}s`,
    `- Threshold: ${formatDurationSeconds(input.thresholdMs)}s`,
    "- Recommended action: confirm assignee availability and checkout automation path health.",
  ].join("\n");
}
