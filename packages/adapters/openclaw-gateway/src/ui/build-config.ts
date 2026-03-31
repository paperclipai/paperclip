import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function buildOpenClawGatewayConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  
  // Required / Primary fields
  if (v.url) ac.url = v.url;
  if (v.authToken) ac.authToken = v.authToken;
  if (v.password) ac.password = v.password;
  if (v.agentId) ac.agentId = v.agentId;
  
  // Session routing fields
  if (v.sessionKeyStrategy) ac.sessionKeyStrategy = v.sessionKeyStrategy;
  if (v.sessionKey) ac.sessionKey = v.sessionKey;
  
  // Timeout fields
  if (typeof v.timeoutSec === "number") ac.timeoutSec = v.timeoutSec;
  if (typeof v.waitTimeoutMs === "number") ac.waitTimeoutMs = v.waitTimeoutMs;
  
  // Device auth fields
  if (typeof v.disableDeviceAuth === "boolean") ac.disableDeviceAuth = v.disableDeviceAuth;
  if (typeof v.autoPairOnFirstConnect === "boolean") ac.autoPairOnFirstConnect = v.autoPairOnFirstConnect;
  if (v.devicePrivateKeyPem) ac.devicePrivateKeyPem = v.devicePrivateKeyPem;
  
  // Gateway identity fields
  if (v.role) ac.role = v.role;
  if (v.scopes) {
    const parsed = v.scopes.split(",").map((s) => s.trim()).filter(Boolean);
    if (parsed.length > 0) ac.scopes = parsed;
  }
  
  // Paperclip API override
  if (v.paperclipApiUrl) ac.paperclipApiUrl = v.paperclipApiUrl;
  
  // Headers
  const headers = parseJsonObject(v.headersJson ?? "");
  if (headers) ac.headers = headers;
  
  // Payload template
  const payloadTemplate = parseJsonObject(v.payloadTemplateJson ?? "");
  if (payloadTemplate) ac.payloadTemplate = payloadTemplate;
  
  // Workspace runtime (from runtimeServicesJson)
  const runtimeServices = parseJsonObject(v.runtimeServicesJson ?? "");
  if (runtimeServices && Array.isArray(runtimeServices.services)) {
    ac.workspaceRuntime = runtimeServices;
  }
  
  return ac;
}
