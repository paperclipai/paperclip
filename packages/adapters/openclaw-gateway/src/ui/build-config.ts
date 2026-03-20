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
  // Token: store in headers.x-openclaw-token to match edit-mode storage
  const token = (v as unknown as Record<string, unknown>).token;
  if (typeof token === "string" && token.trim()) {
    const headers = (ac.headers as Record<string, unknown>) ?? {};
    headers["x-openclaw-token"] = token.trim();
    ac.headers = headers;
  }
  ac.timeoutSec = 120;
  ac.waitTimeoutMs = 120000;
  ac.sessionKeyStrategy = "project";
  ac.role = "operator";
  ac.scopes = ["operator.admin"];
  const payloadTemplate = parseJsonObject(v.payloadTemplateJson ?? "");
  if (payloadTemplate) ac.payloadTemplate = payloadTemplate;
  const runtimeServices = parseJsonObject(v.runtimeServicesJson ?? "");
  if (runtimeServices && Array.isArray(runtimeServices.services)) {
    ac.workspaceRuntime = runtimeServices;
  }
  // Pass selected OpenClaw agent ID into adapter config
  const agentId = (v as unknown as Record<string, unknown>).openclawAgentId;
  if (typeof agentId === "string" && agentId.trim()) {
    ac.agentId = agentId.trim();
  }
  // Pass selected session strategy
  const sessionStrategy = (v as unknown as Record<string, unknown>).openclawSessionStrategy;
  if (typeof sessionStrategy === "string" && sessionStrategy.trim()) {
    ac.sessionKeyStrategy = sessionStrategy.trim();
  }
  // Pass selected model override
  const model = (v as unknown as Record<string, unknown>).openclawModel;
  if (typeof model === "string" && model.trim()) {
    ac.model = model.trim();
  }
  // Pass thinking override
  const thinking = (v as unknown as Record<string, unknown>).openclawThinking;
  if (typeof thinking === "string" && thinking.trim()) {
    ac.thinking = thinking.trim();
  }
  // Pass prompt template
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  return ac;
}
