export function normalizeAgentPermissions(
  permissions: unknown,
): Record<string, unknown> {
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return {};
  }
  return permissions as Record<string, unknown>;
}
