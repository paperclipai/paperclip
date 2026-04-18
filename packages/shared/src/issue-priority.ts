import { ISSUE_PRIORITIES, type IssuePriority } from "./constants.js";

export function normalizeIssuePriority(value: string | null | undefined): IssuePriority | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.toLowerCase() === "urgent") return "critical";
  if (ISSUE_PRIORITIES.includes(trimmed as IssuePriority)) {
    return trimmed as IssuePriority;
  }

  return null;
}

export function normalizeIssuePriorityInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return normalizeIssuePriority(value) ?? value;
}

export function issuePriorityWeight(value: string | null | undefined): number {
  switch (normalizeIssuePriority(value)) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}
