import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_MODEL } from "../index.js";

export function buildOllamaLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ext = v as unknown as Record<string, unknown>;
  const ac: Record<string, unknown> = {};

  const baseUrl =
    typeof ext.baseUrl === "string" && ext.baseUrl.trim()
      ? ext.baseUrl.trim()
      : DEFAULT_OLLAMA_BASE_URL;
  ac.baseUrl = baseUrl;
  ac.model = v.model || DEFAULT_OLLAMA_MODEL;

  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;

  const system = typeof ext.system === "string" && ext.system.trim() ? ext.system.trim() : "";
  if (system) ac.system = system;

  const temperature = typeof ext.temperature === "number" ? ext.temperature : NaN;
  if (!Number.isNaN(temperature) && Number.isFinite(temperature)) ac.temperature = temperature;

  ac.timeoutSec = 300;
  ac.graceSec = 15;

  return ac;
}
