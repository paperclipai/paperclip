import type { AdapterConfigSchema } from "../types.js";
import { asNumber, asString, parseObject } from "../utils.js";

export interface AgentZeroBridgeConfig {
  url: string;
  healthUrl: string | null;
  timeoutMs: number;
  headers: Record<string, string>;
}

function parseHeaders(value: unknown): Record<string, string> {
  const parsed = typeof value === "string"
    ? (() => {
        try {
          const json = JSON.parse(value);
          return typeof json === "object" && json !== null && !Array.isArray(json)
            ? (json as Record<string, unknown>)
            : {};
        } catch {
          return {};
        }
      })()
    : parseObject(value);

  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
    ),
  );
}

function normalizeUrl(value: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`CONFIG_INVALID: ${field} must be an absolute http/https URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`CONFIG_INVALID: ${field} must use http or https`);
  }
  return parsed.toString();
}

export function deriveAgentZeroHealthUrl(invokeUrl: string): string {
  try {
    const parsed = new URL(invokeUrl);
    parsed.pathname = parsed.pathname.replace(/\/invoke\/?$/, "/health");
    return parsed.toString();
  } catch {
    return invokeUrl;
  }
}

export function parseAgentZeroBridgeConfig(raw: Record<string, unknown>): AgentZeroBridgeConfig {
  const url = asString(raw.url, "").trim();
  if (!url) {
    throw new Error("CONFIG_INVALID: url is required");
  }

  const healthUrlRaw = asString(raw.healthUrl, "").trim();
  return {
    url: normalizeUrl(url, "url"),
    healthUrl: healthUrlRaw ? normalizeUrl(healthUrlRaw, "healthUrl") : deriveAgentZeroHealthUrl(url),
    timeoutMs: Math.max(1000, asNumber(raw.timeoutMs, 15000)),
    headers: parseHeaders(raw.headers),
  };
}

export function getAgentZeroBridgeConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "url",
        label: "Invoke URL",
        type: "text",
        required: true,
        default: "http://127.0.0.1:8090/invoke",
        hint: "Fire-and-forget Paperclip bridge endpoint that accepts POST /invoke",
      },
      {
        key: "healthUrl",
        label: "Health URL",
        type: "text",
        default: "http://127.0.0.1:8090/health",
        hint: "Optional bridge health probe endpoint; defaults to /health next to /invoke",
      },
      {
        key: "headers",
        label: "Extra Headers (JSON)",
        type: "textarea",
        hint: "Optional JSON object of extra headers sent to the bridge",
      },
      {
        key: "timeoutMs",
        label: "HTTP Timeout (ms)",
        type: "number",
        default: 15000,
      },
    ],
  };
}
