export interface CreateosConfig {
  apiUrl: string;
  apiKey: string | null;
  shape: string;
  rootfs: string | null;
  region: string | null;
  timeoutMs: number;
  reuseLease: boolean;
}

export function parseConfig(raw: Record<string, unknown>): CreateosConfig {
  const text = (key: string): string | null => {
    const value = raw[key];
    if (value == null) return null;
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
      throw new Error(`${key} must be a non-empty string.`);
    }
    return value.trim();
  };
  const apiUrl = text("apiUrl");
  if (!apiUrl) throw new Error("CreateOS requires an API URL.");
  let url: URL;
  try { url = new URL(apiUrl); } catch { throw new Error("CreateOS API URL is invalid."); }
  // Configuration is board-owned, but never follow redirects with the API key.
  // Plain HTTP is useful for a loopback development server only.
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.search || url.hash ||
      !["", "/", "/v1", "/v1/"].includes(url.pathname)) {
    throw new Error("CreateOS API URL must be an HTTPS origin (optionally ending in /v1); HTTP is allowed on loopback only.");
  }
  const shape = text("shape");
  if (!shape) throw new Error("CreateOS requires a shape from its shape catalog.");
  const timeoutMs = raw.timeoutMs ?? 300_000;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) {
    throw new Error("timeoutMs must be an integer between 1 and 86400000.");
  }
  if (raw.reuseLease != null && typeof raw.reuseLease !== "boolean") {
    throw new Error("reuseLease must be a boolean.");
  }
  return {
    apiUrl: url.origin,
    apiKey: text("apiKey"),
    shape,
    rootfs: text("rootfs"),
    region: text("region"),
    timeoutMs,
    reuseLease: raw.reuseLease === true,
  };
}

export function resolveApiKey(config: CreateosConfig): string {
  const key = config.apiKey ?? process.env.CREATEOS_API_KEY?.trim();
  if (!key || /[\r\n\0]/.test(key)) {
    throw new Error("CreateOS requires an API key in the environment config or CREATEOS_API_KEY.");
  }
  return key;
}
