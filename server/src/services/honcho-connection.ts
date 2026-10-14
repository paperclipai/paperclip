import { connectionInstructionsConfig } from "@paperclipai/shared";

type ConfiguredConnection = { config: Record<string, unknown>; transportConfig?: Record<string, unknown> };

/** Honcho's workspace is connection configuration, independent of its prompt. */
export function honchoWorkspace(connection: ConfiguredConnection): string | null {
  const config = connectionInstructionsConfig(connection);
  if (config.sourceTemplateKey !== "honcho") return null;
  const settings = config.methodConfig;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const value = (settings as Record<string, unknown>).workspaceId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function honchoManagedArguments(
  connection: ConfiguredConnection,
  schema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const workspace = honchoWorkspace(connection);
  const properties = schema.properties;
  return workspace && properties && typeof properties === "object" && "workspace_id" in properties
    ? { workspace_id: workspace }
    : undefined;
}
