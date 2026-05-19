import type { CreateConfigValues } from "../../components/AgentConfigForm";

export function buildAtomicAgentHttpConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url?.trim()) ac.baseUrl = v.url.trim();
  if (v.model?.trim()) ac.model = v.model.trim();
  const key = v.atomicAgentApiKey?.trim();
  if (key) ac.apiKey = key;
  ac.timeoutMs = 600_000;
  return ac;
}
