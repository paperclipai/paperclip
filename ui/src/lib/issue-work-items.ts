import type { IssueWorkItemType } from "@paperclipai/shared";

export function isHumanControlWorkItemType(
  value: unknown,
): value is Extract<IssueWorkItemType, "initiative" | "human_task"> {
  return value === "initiative" || value === "human_task";
}
