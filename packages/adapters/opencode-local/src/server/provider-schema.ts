function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Thrown when a generated provider/tool/function name violates the contract
 * the upstream OpenAI-compatible (or Console Go) provider enforces before a
 * model call. The runtime fails fast with a specific connection/tool so the
 * harness can surface the offending surface instead of letting the provider
 * reject the whole request mid-inference.
 *
 * Canonical tool identity is preserved: we never silently rename an ambiguous
 * tool, we only refuse to spawn the model until the surface is corrected.
 */
export class ProviderSchemaContractError extends Error {
  readonly code = "PROVIDER_SCHEMA_CONTRACT" as const;
  readonly connection?: string;
  readonly tool?: string;
  readonly length: number;
  readonly maxLength: number;

  constructor(offense: {
    kind: "provider" | "model" | "mcp_server" | "tool_function";
    name: string;
    connection?: string;
    length: number;
    maxLength: number;
  }) {
    const where = offense.connection ? ` on connection "${offense.connection}"` : "";
    const label =
      offense.kind === "provider"
        ? `provider connection name "${offense.name}"`
        : offense.kind === "model"
          ? `model id "${offense.name}"`
          : offense.kind === "mcp_server"
            ? `MCP server name "${offense.name}"`
            : `tool/function name "${offense.name}"`;
    super(
      `PROVIDER_SCHEMA_CONTRACT: ${label}${where} is ${offense.length} chars, exceeding the provider limit of ${offense.maxLength}. Refusing model inference until the tool surface is corrected.`,
    );
    this.name = "ProviderSchemaContractError";
    this.connection = offense.connection;
    this.tool = offense.kind === "tool_function" ? offense.name : undefined;
    this.length = offense.length;
    this.maxLength = offense.maxLength;
  }
}

function collectToolFunctionNames(node: unknown, out: Array<{ name: string; connection?: string }>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectToolFunctionNames(item, out);
    return;
  }
  if (!isPlainObject(node)) return;

  // OpenAI-compatible tool shape: { tools: [ { name?, function?: { name? } } ] }
  // or function-calling shape: { functions: [ { name? } ] }.
  for (const key of ["tools", "functions", "tool", "function"]) {
    const value = node[key];
    if (value === undefined || value === null) continue;
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      if (!isPlainObject(entry)) continue;
      if (typeof entry.name === "string" && entry.name.length > 0) {
        out.push({ name: entry.name, connection: node.__connection as string | undefined });
      }
      // function.name nested shape
      if (isPlainObject(entry.function) && typeof entry.function.name === "string" && entry.function.name.length > 0) {
        out.push({ name: entry.function.name, connection: node.__connection as string | undefined });
      }
      collectToolFunctionNames(entry, out);
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === "tools" || key === "functions" || key === "tool" || key === "function") continue;
    collectToolFunctionNames(value, out);
  }
}

export interface ValidateProviderSchemaContractInput {
  /** Resolved provider map (connection id -> provider definition). */
  providers?: Record<string, unknown> | null;
  /** Resolved MCP server map (server id -> server definition). */
  mcp?: Record<string, unknown> | null;
  /** Provider/tool name length ceiling. Defaults to 64 (OpenAI-compatible/Console Go). */
  maxNameLength?: number;
}

/**
 * Validate the generated tool surface against provider name-length limits
 * BEFORE model inference. Throws {@link ProviderSchemaContractError} naming the
 * first offending connection/tool.
 */
export function validateProviderSchemaContract(input: ValidateProviderSchemaContractInput): void {
  const maxLength = input.maxNameLength && input.maxNameLength > 0 ? input.maxNameLength : 64;
  const providers = isPlainObject(input.providers) ? input.providers : {};
  const mcp = isPlainObject(input.mcp) ? input.mcp : {};

  // 1. Provider connection ids are the tool/function namespace for --model provider/model.
  for (const connectionId of Object.keys(providers)) {
    if (connectionId.length > maxLength) {
      throw new ProviderSchemaContractError({
        kind: "provider",
        name: connectionId,
        length: connectionId.length,
        maxLength,
      });
    }
  }

  // 2. Model ids are passed verbatim to the provider and become function routing keys.
  for (const [connectionId, provider] of Object.entries(providers)) {
    if (!isPlainObject(provider)) continue;
    const models = isPlainObject(provider.models) ? provider.models : {};
    for (const modelId of Object.keys(models)) {
      if (modelId.length > maxLength) {
        throw new ProviderSchemaContractError({
          kind: "model",
          name: modelId,
          connection: connectionId,
          length: modelId.length,
          maxLength,
        });
      }
    }
  }

  // 3. MCP server ids become tool-name prefixes for the model.
  for (const serverId of Object.keys(mcp)) {
    if (serverId.length > maxLength) {
      throw new ProviderSchemaContractError({
        kind: "mcp_server",
        name: serverId,
        length: serverId.length,
        maxLength,
      });
    }
  }

  // 4. Recursively scan for tool/function names anywhere in the provider or MCP surface.
  const toolNames: Array<{ name: string; connection?: string }> = [];
  for (const [connectionId, provider] of Object.entries(providers)) {
    collectToolFunctionNames({ ...(isPlainObject(provider) ? provider : {}), __connection: connectionId }, toolNames);
  }
  for (const [serverId, server] of Object.entries(mcp)) {
    collectToolFunctionNames({ ...(isPlainObject(server) ? server : {}), __connection: serverId }, toolNames);
  }
  for (const tool of toolNames) {
    if (tool.name.length > maxLength) {
      throw new ProviderSchemaContractError({
        kind: "tool_function",
        name: tool.name,
        connection: tool.connection,
        length: tool.name.length,
        maxLength,
      });
    }
  }
}
