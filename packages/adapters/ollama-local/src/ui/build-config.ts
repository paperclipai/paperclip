import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_OLLAMA_ENDPOINT } from "../index.js";

function getString(values: CreateConfigValues, key: string): string {
  const schema = values.adapterSchemaValues ?? {};
  const raw = schema[key];
  return typeof raw === "string" ? raw.trim() : "";
}

function getOptions(values: CreateConfigValues): Record<string, unknown> {
  const schema = values.adapterSchemaValues ?? {};
  const raw = schema.options;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

export function buildOllamaLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.model) ac.model = v.model;
  const endpoint = getString(v, "endpoint");
  ac.endpoint = endpoint || DEFAULT_OLLAMA_ENDPOINT;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  const options = getOptions(v);
  if (Object.keys(options).length > 0) ac.options = options;
  ac.postCommentToIssue = true;
  return ac;
}
