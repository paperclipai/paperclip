import { readFileSync } from "node:fs";

export const DEFAULT_PORT = 19327;
export const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3100",
  "http://127.0.0.1:3100",
  "https://company.whitestag.ai",
];

export interface HelperConfig {
  port: number;
  roots: string[];
  allowedOrigins: string[];
}

export function loadConfig(path: string): HelperConfig | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.roots) || obj.roots.length === 0) return null;
  const roots = obj.roots.filter((r): r is string => typeof r === "string");
  if (roots.length === 0) return null;

  const port =
    typeof obj.port === "number" && Number.isFinite(obj.port)
      ? obj.port
      : DEFAULT_PORT;

  const allowedOrigins = Array.isArray(obj.allowedOrigins)
    ? obj.allowedOrigins.filter((o): o is string => typeof o === "string")
    : DEFAULT_ALLOWED_ORIGINS;

  return {
    port,
    roots,
    allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : DEFAULT_ALLOWED_ORIGINS,
  };
}
