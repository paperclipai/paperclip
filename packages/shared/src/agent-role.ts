export const LEGACY_AGENT_ROLE_ALIASES = {
  operations: "coo",
} as const;

export function canonicalizeAgentRole<T extends string | null | undefined>(role: T): T extends string ? string : T {
  if (typeof role !== "string") {
    return role as T extends string ? string : T;
  }
  return (LEGACY_AGENT_ROLE_ALIASES[role as keyof typeof LEGACY_AGENT_ROLE_ALIASES] ?? role) as T extends string ? string : T;
}

export function normalizeAgentRoleInput(value: unknown): unknown {
  return typeof value === "string" ? canonicalizeAgentRole(value) : value;
}
