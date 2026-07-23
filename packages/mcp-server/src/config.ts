export interface PaperclipMcpConfig {
  apiUrl: string;
  // apiKey may be empty at construction. The MCP server allows startup
  // without PAPERCLIP_API_KEY so that a Hermes gateway can spawn it at boot
  // for tool-list discovery (`mcp/list`) before any run-scoped credentials
  // exist. Tool calls that actually need the key surface a clear error at
  // invocation time via `resolveApiKey`.
  apiKey: string;
  companyId: string | null;
  agentId: string | null;
  runId: string | null;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeApiUrl(apiUrl: string): string {
  const trimmed = stripTrailingSlash(apiUrl.trim());
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PaperclipMcpConfig {
  const apiUrl = nonEmpty(env.PAPERCLIP_API_URL);
  if (!apiUrl) {
    throw new Error("Missing PAPERCLIP_API_URL");
  }
  // PAPERCLIP_API_KEY is intentionally NOT required at startup.
  // `resolveApiKey` re-checks `process.env.PAPERCLIP_API_KEY` on every request
  // and throws a clear error if it is still missing when a tool is invoked.
  const apiKey = nonEmpty(env.PAPERCLIP_API_KEY) ?? "";

  return {
    apiUrl: normalizeApiUrl(apiUrl),
    apiKey,
    companyId: nonEmpty(env.PAPERCLIP_COMPANY_ID),
    agentId: nonEmpty(env.PAPERCLIP_AGENT_ID),
    runId: nonEmpty(env.PAPERCLIP_RUN_ID),
  };
}

export function resolveApiKey(
  config: PaperclipMcpConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (config.apiKey) return config.apiKey;
  const fresh = nonEmpty(env.PAPERCLIP_API_KEY);
  if (fresh) return fresh;
  throw new Error(
    "Missing PAPERCLIP_API_KEY: not set at server startup and not present in process.env at request time. " +
      "Provide it via the MCP server's startup env, or inject it before the first tool call.",
  );
}
