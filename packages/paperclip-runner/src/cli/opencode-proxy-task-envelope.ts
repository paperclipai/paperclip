import { createCodexTaskEnvelope } from "../contracts/codex.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
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
      text(params.baseInstructions, "Complete only the supplied task."),
      "Work only inside the supplied working directory.",
      "Use Paperclip MCP tools for semantic operations.",
    ],
  });
}
