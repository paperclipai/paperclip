const MANAGER_REPORT_SCOPE_VALUE_KEYS = new Set([
  "projectId",
  "projectIds",
  "agentId",
  "agentIds",
  "assigneeAgentId",
  "assigneeAgentIds",
  "targetAgentId",
  "targetAgentIds",
  "managerAgentId",
  "managerAgentIds",
  "managedSubtreeAgentId",
  "managedSubtreeAgentIds",
  "subtreeAgentId",
  "subtreeAgentIds",
  "subtreeRootAgentId",
  "subtreeRootAgentIds",
]);

const MANAGER_REPORT_SCOPE_ALLOW_PREFIXES = [
  "project:",
  "agent:",
  "subtree:",
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scopeValueList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function scopeValueListIsWellFormed(value: unknown) {
  if (typeof value === "string") return value.trim().length > 0;
  return Array.isArray(value) && value.length > 0 && value.every(
    (entry) => typeof entry === "string" && entry.trim().length > 0,
  );
}

export function managerReportGrantScopeIsWellFormed(scope: unknown): boolean {
  if (scope === null) return true;
  if (!isPlainRecord(scope) || Object.keys(scope).length === 0) return false;

  for (const [key, value] of Object.entries(scope)) {
    if (!scopeValueListIsWellFormed(value)) return false;
    if (key === "allow") {
      const rules = scopeValueList(value);
      if (!rules.every((rule) => MANAGER_REPORT_SCOPE_ALLOW_PREFIXES.some(
        (prefix) => rule.startsWith(prefix) && rule.slice(prefix.length).length > 0,
      ))) {
        return false;
      }
      continue;
    }
    if (!MANAGER_REPORT_SCOPE_VALUE_KEYS.has(key)) return false;
  }

  return true;
}
