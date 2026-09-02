// Tool-schema context telemetry.
//
// The OpenCode CLI has no pre-run inventory endpoint, but Paperclip
// deterministically derives the injected managed/core/wrapper tools and their
// config. This module turns that derived inventory into the runtime diagnostics
// metrics the issue requires: registeredToolCount, toolsBySource,
// duplicateToolNames, serializedToolSchemaChars. Provider-native schemas that
// Paperclip genuinely cannot enumerate are reported with explicit `unsupported`
// measurement kind + reason; we never silently return NOT_EXPOSED when a
// deterministic derivation is possible.

export type ToolSource = "managed" | "core" | "wrapper" | "provider-native" | (string & {});

export interface ToolInventoryEntry {
  name: string;
  source: ToolSource;
  /**
   * Optional serialized JSON schema for this tool (e.g. the input schema
   * Paperclip derived from the MCP tool definition). Used to compute
   * serializedToolSchemaChars. When omitted, the tool still counts toward
   * registeredToolCount but contributes 0 chars.
   */
  serializedSchema?: string;
}

export interface ToolSchemaTelemetryInput {
  tools: ToolInventoryEntry[];
  /**
   * Whole-config serialized size in chars, if Paperclip has the generated
   * runtime config. Added on top of per-tool schema chars. Optional.
   */
  serializedConfigChars?: number;
}

export interface ToolSchemaTelemetry {
  registeredToolCount: number;
  toolsBySource: Record<string, number>;
  duplicateToolNames: string[];
  serializedToolSchemaChars: number;
  measurementKind: "derived" | "unsupported";
  /** Present only when measurementKind === "unsupported". */
  unsupportedReason?: string;
}

export function deriveToolSchemaTelemetry(
  input: ToolSchemaTelemetryInput,
): ToolSchemaTelemetry {
  const tools = input.tools ?? [];
  const toolsBySource: Record<string, number> = {};
  const seen = new Map<string, number>();
  let serializedToolSchemaChars = 0;

  for (const tool of tools) {
    const source = tool.source ?? "managed";
    toolsBySource[source] = (toolsBySource[source] ?? 0) + 1;
    seen.set(tool.name, (seen.get(tool.name) ?? 0) + 1);
    if (typeof tool.serializedSchema === "string") {
      serializedToolSchemaChars += tool.serializedSchema.length;
    }
  }

  if (typeof input.serializedConfigChars === "number") {
    serializedToolSchemaChars += input.serializedConfigChars;
  }

  const duplicateToolNames = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort();

  return {
    registeredToolCount: tools.length,
    toolsBySource,
    duplicateToolNames,
    serializedToolSchemaChars,
    measurementKind: "derived",
  };
}

/**
 * Explicit unsupported result for the genuinely unknowable case (e.g. a
 * provider-native schema Paperclip cannot enumerate). Keeps the field non-null
 * with a stated reason instead of a silent NOT_EXPOSED.
 */
export function unsupportedToolSchemaTelemetry(reason: string): ToolSchemaTelemetry {
  return {
    registeredToolCount: 0,
    toolsBySource: {},
    duplicateToolNames: [],
    serializedToolSchemaChars: 0,
    measurementKind: "unsupported",
    unsupportedReason: reason,
  };
}
