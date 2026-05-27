export interface GatewayConfig {
  port: number;
  bridgeSharedSecret: string;
  paperclipApiUrl: string;
  paperclipApiKey: string;
  paperclipCompanyId: string;
  webhookSecret: string;
  inactivityTimeoutMs: number;
}

export function loadConfig(): GatewayConfig {
  const required = (key: string): string => {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
  };

  return {
    port: parseInt(process.env["PORT"] || "3200", 10),
    bridgeSharedSecret: required("BRIDGE_SHARED_SECRET"),
    paperclipApiUrl: required("PAPERCLIP_API_URL"),
    paperclipApiKey: required("PAPERCLIP_API_KEY"),
    paperclipCompanyId: required("PAPERCLIP_COMPANY_ID"),
    webhookSecret: required("WEBHOOK_SECRET"),
    inactivityTimeoutMs: parseInt(
      process.env["INACTIVITY_TIMEOUT_MS"] || String(24 * 60 * 60 * 1000),
      10,
    ),
  };
}
