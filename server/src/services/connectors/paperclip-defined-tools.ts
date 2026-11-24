import { googleWorkspaceRestToolDefinition, type GoogleWorkspaceRestToolDefinition } from "../google-workspace-rest-dispatch.js";
import { pluginConnectionMethod, pluginConnectionToolDefinition } from "../plugin-connector-runtime.js";

export type PaperclipDefinedTool = GoogleWorkspaceRestToolDefinition;

type Connection = { config: Record<string, unknown> };

const PAPERCLIP_DEFINED_TOOL_SOURCES: ReadonlyArray<{
  matches: (connection: Connection) => boolean;
  definition: (toolName: string, connection: Connection) => PaperclipDefinedTool | null;
}> = [
  { matches: (connection) => connection.config.sourceTemplateKey === "google-workspace", definition: googleWorkspaceRestToolDefinition },
  {
    matches: (connection) => pluginConnectionMethod(connection)?.method.tools?.kind === "static",
    definition: (toolName, connection) => pluginConnectionToolDefinition(connection, toolName),
  },
];

export function paperclipDefinedTool(connection: Connection, toolName: string): PaperclipDefinedTool | null {
  return PAPERCLIP_DEFINED_TOOL_SOURCES.find((source) => source.matches(connection))?.definition(toolName, connection) ?? null;
}
