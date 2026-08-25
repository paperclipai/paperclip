import type { EnvSecretRefBinding } from "@paperclipai/plugin-sdk";
import { WeknoraPluginError } from "./errors.js";

export const DEFAULT_CONFIG = {
  maxResults: 8,
  maxChunkChars: 1200,
  requestTimeoutMs: 30000,
  resourceUrls: "handle" as const,
  enableWriteActions: false,
};

export type WeKnoraConfig = {
  baseUrl: string;
  apiKeyRef: EnvSecretRefBinding;
  tenantId?: string;
  defaultKnowledgeBaseIds: string[];
  defaultWikiKnowledgeBaseId?: string;
  maxResults: number;
  maxChunkChars: number;
  requestTimeoutMs: number;
  resourceUrls: "handle";
  enableWriteActions: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WeknoraPluginError("invalid_config", `${field} is required`, false);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WeknoraPluginError("invalid_config", `${field} must be a non-empty string`, false);
  }
  return value.trim();
}

function numericOption(value: unknown, field: string, defaultValue: number, min: number, max: number): number {
  const candidate = value == null ? defaultValue : value;
  if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < min || candidate > max) {
    throw new WeknoraPluginError("invalid_config", `${field} must be an integer from ${min} to ${max}`, false);
  }
  return candidate;
}

function secretRef(value: unknown): EnvSecretRefBinding {
  if (!isRecord(value) || value.type !== "secret_ref" || typeof value.secretId !== "string" || value.secretId.trim().length === 0) {
    throw new WeknoraPluginError("invalid_config", "apiKeyRef must be a Paperclip secret_ref object", false);
  }
  return value as unknown as EnvSecretRefBinding;
}

export function normalizeBaseUrl(value: unknown): string {
  const raw = requiredString(value, "baseUrl");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new WeknoraPluginError("invalid_config", "baseUrl must be an absolute HTTP(S) URL", false);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WeknoraPluginError("invalid_config", "baseUrl must use HTTP or HTTPS", false);
  }
  if (parsed.username || parsed.password) {
    throw new WeknoraPluginError("invalid_config", "baseUrl must not contain URL credentials", false);
  }
  if (parsed.hash) {
    throw new WeknoraPluginError("invalid_config", "baseUrl must not contain a URL fragment", false);
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/api/v1")) {
    parsed.pathname = pathname;
  } else {
    parsed.pathname = `${pathname}/api/v1`.replace(/^\/\//, "/");
  }
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

export function normalizeConfig(raw: Record<string, unknown>): WeKnoraConfig {
  const defaultKnowledgeBaseIdsValue = raw.defaultKnowledgeBaseIds;
  const defaultKnowledgeBaseIds = defaultKnowledgeBaseIdsValue == null
    ? []
    : Array.isArray(defaultKnowledgeBaseIdsValue)
      ? defaultKnowledgeBaseIdsValue.map((value) => requiredString(value, "defaultKnowledgeBaseIds item"))
      : (() => { throw new WeknoraPluginError("invalid_config", "defaultKnowledgeBaseIds must be an array", false); })();
  if (defaultKnowledgeBaseIds.length > 50) {
    throw new WeknoraPluginError("invalid_config", "defaultKnowledgeBaseIds must contain at most 50 ids", false);
  }

  const resourceUrls = raw.resourceUrls == null ? DEFAULT_CONFIG.resourceUrls : raw.resourceUrls;
  if (resourceUrls !== "handle") {
    throw new WeknoraPluginError("invalid_config", "resourceUrls must be handle", false);
  }

  if (raw.enableWriteActions != null && typeof raw.enableWriteActions !== "boolean") {
    throw new WeknoraPluginError("invalid_config", "enableWriteActions must be a boolean", false);
  }

  return {
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    apiKeyRef: secretRef(raw.apiKeyRef),
    tenantId: optionalString(raw.tenantId, "tenantId"),
    defaultKnowledgeBaseIds,
    defaultWikiKnowledgeBaseId: optionalString(raw.defaultWikiKnowledgeBaseId, "defaultWikiKnowledgeBaseId"),
    maxResults: numericOption(raw.maxResults, "maxResults", DEFAULT_CONFIG.maxResults, 1, 50),
    maxChunkChars: numericOption(raw.maxChunkChars, "maxChunkChars", DEFAULT_CONFIG.maxChunkChars, 200, 10000),
    requestTimeoutMs: numericOption(raw.requestTimeoutMs, "requestTimeoutMs", DEFAULT_CONFIG.requestTimeoutMs, 1000, 120000),
    resourceUrls: "handle",
    enableWriteActions: raw.enableWriteActions == null ? DEFAULT_CONFIG.enableWriteActions : raw.enableWriteActions,
  };
}
