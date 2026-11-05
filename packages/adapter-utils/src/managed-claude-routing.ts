// These variables control managed Claude credentials, provider selection, or
// transport. Explicit empty values keep project settings from introducing a
// different route when the selected connection did not configure one.
export const MANAGED_CLAUDE_ROUTING_ENV_KEYS = [
  "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI", "GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_ACCESS_TOKEN", "ANTHROPIC_FOUNDRY_RESOURCE", "ANTHROPIC_FOUNDRY_BASE_URL",
  "AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_CLIENT_SECRET", "AZURE_FEDERATED_TOKEN_FILE",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS",
] as const;

export function managedClaudeRoutingEnvironment(env: Record<string, string | undefined>, platform = process.platform): Record<string, string> {
  const windowsKeys = platform === "win32"
    ? new Map(Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]))
    : null;
  return Object.fromEntries(MANAGED_CLAUDE_ROUTING_ENV_KEYS.map((key) => [
    key, (windowsKeys ? windowsKeys.get(key.toUpperCase()) : env[key]) ?? "",
  ]));
}
