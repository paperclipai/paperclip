import type { CloudflareDriverConfig } from "./types.js";

const DEFAULT_REQUESTED_CWD = "/workspace/paperclip";
const DEFAULT_SLEEP_AFTER = "10m";
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS = 300_000;
const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return value === undefined ? fallback : value === true;
}

function readInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function isLocalBridgeHost(url: URL): boolean {
  return LOCALHOST_HOSTNAMES.has(url.hostname);
}

export function parseCloudflareDriverConfig(raw: Record<string, unknown>): CloudflareDriverConfig {
  return {
    bridgeBaseUrl: readTrimmedString(raw.bridgeBaseUrl) ?? "",
    bridgeAuthToken: readTrimmedString(raw.bridgeAuthToken) ?? "",
    reuseLease: readBoolean(raw.reuseLease, false),
    keepAlive: readBoolean(raw.keepAlive, false),
    sleepAfter: readTrimmedString(raw.sleepAfter) ?? DEFAULT_SLEEP_AFTER,
    normalizeId: readBoolean(raw.normalizeId, true),
    requestedCwd: readTrimmedString(raw.requestedCwd) ?? DEFAULT_REQUESTED_CWD,
    sessionStrategy: raw.sessionStrategy === "default" ? "default" : "named",
    sessionId: readTrimmedString(raw.sessionId) ?? "paperclip",
    timeoutMs: readInteger(raw.timeoutMs, DEFAULT_TIMEOUT_MS),
    bridgeRequestTimeoutMs: readInteger(raw.bridgeRequestTimeoutMs, DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS),
    previewHostname: readTrimmedString(raw.previewHostname),
  };
}

export function validateCloudflareDriverConfig(config: CloudflareDriverConfig): string[] {
  const errors: string[] = [];

  if (!config.bridgeBaseUrl) {
    errors.push("Cloudflare sandbox environments require bridgeBaseUrl.");
  } else {
    try {
      const url = new URL(config.bridgeBaseUrl);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalBridgeHost(url))) {
        errors.push("bridgeBaseUrl must use HTTPS unless it points at localhost.");
      }
    } catch {
      errors.push("bridgeBaseUrl must be a valid URL.");
    }
  }

  if (!config.bridgeAuthToken) {
    errors.push("Cloudflare sandbox environments require bridgeAuthToken.");
  }

  if (config.reuseLease && !config.keepAlive) {
    errors.push("reuseLease requires keepAlive for Cloudflare sandboxes.");
  }

  if (config.timeoutMs < 1 || config.timeoutMs > 86_400_000) {
    errors.push("timeoutMs must be between 1 and 86400000.");
  }

  if (config.bridgeRequestTimeoutMs < 1 || config.bridgeRequestTimeoutMs > 86_400_000) {
    errors.push("bridgeRequestTimeoutMs must be between 1 and 86400000.");
  }

  if (!config.requestedCwd.startsWith("/")) {
    errors.push("requestedCwd must be an absolute POSIX path.");
  }

  if (config.sessionStrategy === "named" && config.sessionId.trim().length === 0) {
    errors.push("sessionId is required when sessionStrategy is named.");
  }

  return errors;
}
