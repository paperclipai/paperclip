import { createCodexTaskEnvelope } from "../contracts/codex.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Runnerd's per-turn `paperclipCompletionContract`, or undefined when absent or malformed. */
export function openCodeProxyCompletionContract(value: unknown): { revision: string; criterionIds: string[] } | undefined {
  const contract = record(value);
  const revision = text(contract.revision).trim();
  const criterionIds = Array.isArray(contract.criterionIds)
    ? contract.criterionIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim())
    : [];
  return revision && criterionIds.length > 0 && criterionIds.length === (contract.criterionIds as unknown[]).length
    ? { revision, criterionIds }
    : undefined;
}

/** Whether two per-turn contracts name the same revision and criterion ids, in order. */
export function sameOpenCodeProxyCompletionContract(
  left: { revision: string; criterionIds: readonly string[] } | undefined,
  right: { revision: string; criterionIds: readonly string[] } | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.revision === right.revision
    && left.criterionIds.length === right.criterionIds.length
    && left.criterionIds.every((id, index) => id === right.criterionIds[index]);
}

export function openCodeProxyTaskEnvelope(params: Record<string, unknown>) {
  const completionContract = record(params.completionContract);
  const revision = text(completionContract.revision).trim();
  const criterionIds = Array.isArray(completionContract.criterionIds)
    ? completionContract.criterionIds
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim())
    : [];
  return createCodexTaskEnvelope({
    objective: "Complete the provider turn supplied by Paperclip Runner.",
    ...(revision && criterionIds.length > 0
      ? {
          contractRevision: revision,
          criteria: criterionIds.map((id) => ({
            id,
            requirement: `Satisfy the Paperclip completion criterion ${id}.`,
          })),
        }
      : {}),
    constraints: [
      // baseInstructions already travels in the system prompt. Keep task
      // constraints here without duplicating the agent instruction bundle.
      "Use Paperclip MCP tools for semantic operations.",
    ],
  });
}
