export interface KvDemoConfig {
  port: number;
  host: string;
  /** Optional shared secret. When set, all routes require it. */
  token: string | null;
}

export interface KvDemoConfigInput {
  port?: string | number | null;
  host?: string | null;
  token?: string | null;
}

function parsePort(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || raw === "") return 8848;
  const port = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return port;
}

export function createKvDemoConfig(input: KvDemoConfigInput): KvDemoConfig {
  const token = input.token?.trim();
  return {
    port: parsePort(input.port),
    host: input.host?.trim() || "127.0.0.1",
    token: token ? token : null,
  };
}

export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): KvDemoConfig {
  return createKvDemoConfig({
    port: env.PORT ?? env.KV_DEMO_PORT,
    host: env.KV_DEMO_HOST,
    token: env.KV_DEMO_TOKEN,
  });
}
