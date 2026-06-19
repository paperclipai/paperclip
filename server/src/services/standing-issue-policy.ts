export function readStandingIssueOverride(policy: unknown, key: "allowExecution" | "allowTerminal") {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return false;
  const standing = (policy as Record<string, unknown>).standing;
  if (!standing || typeof standing !== "object" || Array.isArray(standing)) return false;
  const record = standing as Record<string, unknown>;
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  return record[key] === true && reason.length > 0;
}
