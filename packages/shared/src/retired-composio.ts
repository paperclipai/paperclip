/** Persisted broker records must never fall through to generic MCP dispatch. */
export function isRetiredComposioConnection(connection: {
  transport: string;
  config?: Record<string, unknown> | null;
}): boolean {
  return (connection.config?.sourceTemplateKey === "composio" && connection.transport === "rest_api")
    || connection.config?.provider === "composio";
}

export const RETIRED_COMPOSIO_MESSAGE =
  "This legacy Composio connection is no longer supported. Add a new Composio MCP connection from Connectors, then remove this connection. Existing credentials and permissions are not migrated.";
