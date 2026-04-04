export const PLUGIN_ID = "paperclip.darwin-brain-bridge";
export const PLUGIN_VERSION = "0.1.0";

export const TOOL_NAMES = {
  search: "darwin.search",
  searchTenant: "darwin.searchTenant",
  store: "darwin.store",
  info: "darwin.info",
} as const;

export const DEFAULT_DARWIN_SERVER_COMMAND = "node";
export const DEFAULT_DARWIN_SERVER_ARGS = JSON.stringify([
  "/Users/jamie/Projects/skootle/skootle-demos/mcp-servers/darwin-search/dist/index.js",
]);
export const DEFAULT_UPSTASH_URL_ENV_VAR = "UPSTASH_VECTOR_REST_URL";
export const DEFAULT_UPSTASH_TOKEN_ENV_VAR = "UPSTASH_VECTOR_REST_TOKEN";
export const DEFAULT_STORE_ENABLED_ENV_VAR = "DARWIN_ENABLE_STORE";
export const DEFAULT_SHARED_NAMESPACE = "shared";
export const DEFAULT_TIMEOUT_MS = 15000;
