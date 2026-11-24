import { googleWorkspaceRestToolDefinition } from "../google-workspace-rest-dispatch.js";
import { pluginConnectionMethod, pluginConnectionToolDefinition } from "../plugin-connector-runtime.js";

export interface PaperclipDefinedToolDefinition {
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  annotations: Record<string, unknown>;
}

type Connection = { config: Record<string, unknown> };

const PAPERCLIP_DEFINED_TOOL_SOURCES: ReadonlyArray<{
  matches: (connection: Connection) => boolean;
  definition: (toolName: string) => PaperclipDefinedToolDefinition | null;
}> = [
  { matches: (connection) => connection.config.sourceTemplateKey === "google-workspace", definition: googleWorkspaceRestToolDefinition },
];

export function paperclipDefinedTool(connection: Connection, toolName: string): PaperclipDefinedToolDefinition | null {
  return PAPERCLIP_DEFINED_TOOL_SOURCES.find((source) => source.matches(connection))?.definition(toolName) ?? null;
}

export function currentConnectionToolDefinition(connection: Connection, toolName: string): PaperclipDefinedToolDefinition | null {
  const trusted = paperclipDefinedTool(connection, toolName);
  if (trusted) return trusted;
  if (connection.config.quarantineNewEntries === true) return null;
  if (pluginConnectionMethod(connection)?.method.tools?.kind !== "static") return null;
  return pluginConnectionToolDefinition(connection, toolName);
}
