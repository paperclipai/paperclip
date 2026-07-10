export type AgentExecutionAccess = "read_write" | "read_only";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function agentExecutionAccess(metadata: unknown): AgentExecutionAccess {
  const root = asRecord(metadata);
  const managed = asRecord(root?.pluginManagedAgent);
  return managed?.executionAccess === "readOnly" ? "read_only" : "read_write";
}

export function isReadOnlyAgent(metadata: unknown): boolean {
  return agentExecutionAccess(metadata) === "read_only";
}
