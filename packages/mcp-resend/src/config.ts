export interface ResendMcpConfig {
  apiKey: string;
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ResendMcpConfig {
  return { apiKey: requireEnv(env, "RESEND_API_KEY") };
}
