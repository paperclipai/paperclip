import type { CreateConfigValues } from "../../components/AgentConfigForm";

export function buildHttpConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url) ac.url = v.url;
  ac.method = "POST";
  ac.timeoutMs = 15000;
  return ac;
}
