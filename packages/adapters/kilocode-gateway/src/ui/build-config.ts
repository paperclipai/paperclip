import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function asNum(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return isFinite(n) ? n : fallback;
}

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

export function buildKilocodeGatewayConfig(v: CreateConfigValues): Record<string, unknown> {
  const sv = v.adapterSchemaValues ?? {};
  const ac: Record<string, unknown> = {};
  if (sv.apiKey) ac.apiKey = sv.apiKey;
  if (v.model) ac.model = v.model;
  if (sv.baseUrl ?? v.url) ac.baseUrl = sv.baseUrl ?? v.url;
  ac.temperature = asNum(sv.temperature, 0.7);
  ac.maxTokens = asNum(sv.maxTokens, 8192);
  ac.stream = asBool(sv.stream, true);
  ac.timeoutSec = 120;
  return ac;
}
