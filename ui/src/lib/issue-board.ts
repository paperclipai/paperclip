import type { Issue } from "@paperclipai/shared";

export function shouldShowBoardProjectChip(issues: Issue[], projectId?: string): boolean {
  if (projectId) return false;

  const visibleProjectIds = new Set(
    issues
      .map((issue) => issue.projectId)
      .filter((value): value is string => Boolean(value)),
  );

  return visibleProjectIds.size > 1;
}
