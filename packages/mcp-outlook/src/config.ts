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
    tenantId: requireEnv(env, "OUTLOOK_TENANT_ID"),
    clientId: requireEnv(env, "OUTLOOK_CLIENT_ID"),
    clientSecret: requireEnv(env, "OUTLOOK_CLIENT_SECRET"),
    mailbox: requireEnv(env, "OUTLOOK_MAILBOX"),
  };
}
