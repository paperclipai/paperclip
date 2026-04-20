export interface SharepointMcpConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  siteUrl: string;
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

function optionalEnv(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  return env[key]?.trim() || fallback;
}

export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SharepointMcpConfig {
  return {
    tenantId: requireEnv(env, "SHAREPOINT_TENANT_ID"),
    clientId: requireEnv(env, "SHAREPOINT_CLIENT_ID"),
    clientSecret: requireEnv(env, "SHAREPOINT_CLIENT_SECRET"),
    siteUrl: optionalEnv(
      env,
      "SHAREPOINT_SITE_URL",
      "https://medicodio.sharepoint.com/sites/MedicodioMarketing",
    ),
  };
}
