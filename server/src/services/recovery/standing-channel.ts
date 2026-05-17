import { normalizeIssueExecutionPolicy } from "../issue-execution-policy.js";

type IssueExecutionPolicyCarrier = {
  executionPolicy?: unknown | null;
};

export function isStandingChannelIssue(issue: IssueExecutionPolicyCarrier | null | undefined): boolean {
  if (!issue) return false;

  try {
    const normalized = normalizeIssueExecutionPolicy(issue.executionPolicy ?? null);
    if (normalized?.monitor?.standingChannel === true) return true;
  } catch {
    // Fall back to raw policy shape checks for forward/backward compatibility.
  }

  const rawPolicy = issue.executionPolicy;
  if (!rawPolicy || typeof rawPolicy !== "object") return false;
  const monitor = (rawPolicy as { monitor?: unknown }).monitor;
  if (!monitor || typeof monitor !== "object") return false;
  return (monitor as { standingChannel?: unknown }).standingChannel === true;
}
