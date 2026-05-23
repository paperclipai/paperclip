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
  if (v.url) ac.url = v.url;
  ac.timeoutSec = 120;

  const waitTimeoutMs = v.openClawWaitTimeoutMs ? Number.parseInt(v.openClawWaitTimeoutMs, 10) : NaN;
  ac.waitTimeoutMs = Number.isFinite(waitTimeoutMs) && waitTimeoutMs > 0 ? waitTimeoutMs : 120000;

  ac.sessionKeyStrategy = v.openClawSessionKeyStrategy || "issue";
  ac.role = v.openClawRole || "operator";

  const scopes = v.openClawScopes
    ? v.openClawScopes.split(",").map((s) => s.trim()).filter(Boolean)
    : ["operator.admin"];
  ac.scopes = scopes.length > 0 ? scopes : ["operator.admin"];

  const token = v.openClawToken?.trim();
  if (token) ac.headers = { "x-openclaw-token": token };

  if (v.openClawPaperclipApiUrl?.trim()) ac.paperclipApiUrl = v.openClawPaperclipApiUrl.trim();

  const payloadTemplate = parseJsonObject(v.payloadTemplateJson ?? "");
  if (payloadTemplate) ac.payloadTemplate = payloadTemplate;
  const runtimeServices = parseJsonObject(v.runtimeServicesJson ?? "");
  if (runtimeServices && Array.isArray(runtimeServices.services)) {
    ac.workspaceRuntime = runtimeServices;
  }
  return ac;
}
