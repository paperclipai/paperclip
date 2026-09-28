export interface ExecutionGrantDisplayRequest {
  executorAgentId: string;
  targetAgentId: string;
  targetRevisionId: string | null;
  targetUpdatedAt: string;
  requestBody: Record<string, unknown>;
  requestHash: string;
  expiresAt: string;
  policyVersion: number;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

/** The exact text stored with the decision and checked again before issuance. */
export function executionGrantApprovalDetails(request: ExecutionGrantDisplayRequest): string {
  const bodyLines = JSON.stringify(canonicalize(request.requestBody), null, 2)
    .split("\n").map((line) => `+${line}`);
  const codeLines = [`+++ PATCH /api/agents/${request.targetAgentId}`, ...bodyLines];
  // Keep proposer-controlled backticks inside one code block even if a value
  // contains Markdown fence syntax. JSON.stringify escapes embedded newlines.
  const longestBacktickRun = Math.max(0, ...codeLines.flatMap((line) =>
    [...line.matchAll(/`+/g)].map(([run]) => run.length)));
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return [
    "Approve one exact agent configuration write.",
    `Executor agent: ${request.executorAgentId}`,
    `Target agent: ${request.targetAgentId}`,
    `Target revision: ${request.targetRevisionId ?? "none"}`,
    `Target updated at: ${request.targetUpdatedAt}`,
    `Expires at: ${request.expiresAt}`,
    `Policy version: ${request.policyVersion}`,
    "",
    `${fence}diff`,
    `+++ PATCH /api/agents/${request.targetAgentId}`,
    ...bodyLines,
    fence,
    `Request SHA-256: ${request.requestHash}`,
  ].join("\n");
}
