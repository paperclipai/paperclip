import {
  googleWorkspacePaperclipToolTitle,
  googleWorkspaceRestShippedSchemaHashes,
  googleWorkspaceRestToolDefinition,
} from "../google-workspace-rest-dispatch.js";
import type { toolConnections } from "@paperclipai/db";
import { pluginConnectionMethod, pluginConnectionToolDefinition } from "../plugin-connector-runtime.js";
import { shouldQuarantineNewEntries } from "../tool-access/catalog/descriptors.js";

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
  shippedSchemaHashes: (toolName: string) => readonly string[];
  authoredTitle: (toolName: string) => string | null;
}> = [
  {
    matches: (connection) => connection.config.sourceTemplateKey === "google-workspace",
    definition: googleWorkspaceRestToolDefinition,
    shippedSchemaHashes: googleWorkspaceRestShippedSchemaHashes,
    authoredTitle: googleWorkspacePaperclipToolTitle,
  },
];

export function paperclipDefinedTool(connection: Connection, toolName: string): PaperclipDefinedToolDefinition | null {
  return PAPERCLIP_DEFINED_TOOL_SOURCES.find((source) => source.matches(connection))?.definition(toolName) ?? null;
}

export function shippedPaperclipSchemaHashes(connection: Connection, toolName: string): readonly string[] {
  return PAPERCLIP_DEFINED_TOOL_SOURCES.find((source) => source.matches(connection))?.shippedSchemaHashes(toolName) ?? [];
}

export function paperclipAuthoredToolTitle(connection: Connection, toolName: string): string | null {
  return PAPERCLIP_DEFINED_TOOL_SOURCES.find((source) => source.matches(connection))?.authoredTitle(toolName) ?? null;
}

export function currentConnectionToolDefinition(connection: typeof toolConnections.$inferSelect, toolName: string): PaperclipDefinedToolDefinition | null {
  const trusted = paperclipDefinedTool(connection, toolName);
  if (trusted) return trusted;
  if (shouldQuarantineNewEntries(connection)) return null;
  if (pluginConnectionMethod(connection)?.method.tools?.kind !== "static") return null;
  return pluginConnectionToolDefinition(connection, toolName);
}
