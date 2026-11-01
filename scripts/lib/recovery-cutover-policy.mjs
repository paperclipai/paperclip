/** File contents belong to each recovery owner. Inventory never parses them:
 * even an apparently valid file cannot establish that its obligation settled. */
export const recoveryKinds = ["accounting-receipts", "quota-credential-recovery", "sandbox-orphan-cleanup"];

export function classifyRecoveryEntry(kind, depth, entry) {
  if (entry === "file") return "unverifiedFiles";
  if (entry === "company-directory" && kind === "quota-credential-recovery" && depth === 0) return "descend";
  return "unknownEntries";
}

export function cutoverStatus(summary) {
  if (!summary.complete || summary.unknownEntries > 0 || summary.readFailures > 0) return "unknown";
  return summary.unverifiedFiles > 0 ? "blocked" : "clear";
}
