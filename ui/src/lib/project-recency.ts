import type { Project } from "@paperclipai/shared";

type ProjectWithOptionalActivity = Project & {
  lastActivityAt?: Date | string | null;
};

function toTimestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 0 : value.getTime();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

export function sortProjectsByRecentActivity(projects: Project[]): Project[] {
  return [...projects].sort((left, right) => {
    const rightActivity = right as ProjectWithOptionalActivity;
    const leftActivity = left as ProjectWithOptionalActivity;
    const lastActivityDelta = toTimestamp(rightActivity.lastActivityAt) - toTimestamp(leftActivity.lastActivityAt);
    if (lastActivityDelta !== 0) return lastActivityDelta;

    const updatedAtDelta = toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt);
    if (updatedAtDelta !== 0) return updatedAtDelta;

    const nameDelta = left.name.localeCompare(right.name);
    if (nameDelta !== 0) return nameDelta;

    return left.id.localeCompare(right.id);
  });
}
