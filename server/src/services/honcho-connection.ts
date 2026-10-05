/** Honcho's workspace is connection configuration, independent of its prompt. */
export function honchoWorkspace(connection: { config: Record<string, unknown> }): string | null {
  if (connection.config.sourceTemplateKey !== "honcho") return null;
  const settings = connection.config.methodConfig;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const value = (settings as Record<string, unknown>).workspaceId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function honchoManagedArguments(
  connection: { config: Record<string, unknown> },
  schema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const workspace = honchoWorkspace(connection);
  const properties = schema.properties;
  return workspace && properties && typeof properties === "object" && "workspace_id" in properties
    ? { workspace_id: workspace }
    : undefined;
}
