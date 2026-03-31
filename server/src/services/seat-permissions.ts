import type { PermissionKey } from "@paperclipai/shared";

export function delegatedPermissionsFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): PermissionKey[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const values = metadata.delegatedPermissions;
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is PermissionKey => typeof value === "string");
}
