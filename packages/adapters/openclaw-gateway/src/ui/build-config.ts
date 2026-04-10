import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_OPENCLAW_GATEWAY_WS_URL } from "../defaults.js";

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
  const trimmedUrl = typeof v.url === "string" ? v.url.trim() : "";
  ac.url = trimmedUrl || DEFAULT_OPENCLAW_GATEWAY_WS_URL;
  const gatewayTok =
    typeof v.openclawGatewayToken === "string" ? v.openclawGatewayToken.trim() : "";
  if (gatewayTok) {
    ac.headers = { "x-openclaw-token": gatewayTok };
  }
  ac.timeoutSec = 120;
  ac.waitTimeoutMs = 120000;
  ac.sessionKeyStrategy = "issue";
  ac.role = "operator";
  ac.scopes = ["operator.admin"];
  const payloadTemplate = parseJsonObject(v.payloadTemplateJson ?? "");
  if (payloadTemplate) ac.payloadTemplate = payloadTemplate;
  const runtimeServices = parseJsonObject(v.runtimeServicesJson ?? "");
  if (runtimeServices && Array.isArray(runtimeServices.services)) {
    ac.workspaceRuntime = runtimeServices;
  }
  return ac;
}
