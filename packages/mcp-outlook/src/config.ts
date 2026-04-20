export interface OutlookMcpConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  mailbox: string;
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OutlookMcpConfig {
  return {
    tenantId: requireEnv(env, "SHAREPOINT_TENANT_ID"),
    clientId: requireEnv(env, "SHAREPOINT_CLIENT_ID"),
    clientSecret: requireEnv(env, "SHAREPOINT_CLIENT_SECRET"),
    mailbox: requireEnv(env, "OUTLOOK_MAILBOX"),
  };
}
