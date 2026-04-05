import type { CreateConfigValues } from "../../components/AgentConfigForm";

export function buildHttpConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url) ac.url = v.url;
  ac.method = "POST";
  ac.timeoutMs = typeof v.timeoutMs === "number" && v.timeoutMs > 0 ? v.timeoutMs : 15000;
  if (v.authorizationHeader) {
    ac.headers = { Authorization: v.authorizationHeader };
  }
  return ac;
}
