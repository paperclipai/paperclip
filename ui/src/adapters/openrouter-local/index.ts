import type { UIAdapterModule, TranscriptEntry, CreateConfigValues } from "../types";
import { OpenRouterLocalConfigFields } from "./config-fields";

function parseOpenRouterStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];

  if (line.startsWith("[openrouter]")) {
    const content = line.slice("[openrouter] ".length);

    if (content.startsWith("Tool: ")) {
      entries.push({ kind: "tool_call", ts, name: content.slice(6), input: {} });
    } else if (content.startsWith("$ ")) {
      entries.push({ kind: "tool_call", ts, name: "shell", input: { command: content.slice(2) } });
    } else if (content.startsWith("Response:")) {
      entries.push({ kind: "assistant", ts, text: content.slice(10).trim() });
    } else if (content.startsWith("Starting") || content.startsWith("Done in") || content.startsWith("Task:")) {
      entries.push({ kind: "system", ts, text: content });
    } else {
      entries.push({ kind: "stdout", ts, text: content });
    }
  } else if (line.trim()) {
    entries.push({ kind: "stdout", ts, text: line });
  }

  return entries;
}

function buildOpenRouterConfig(values: CreateConfigValues): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (values.model) config.model = values.model;
  if (values.cwd) config.cwd = values.cwd;
  if (values.instructionsFilePath) config.instructionsFilePath = values.instructionsFilePath;
  if (values.promptTemplate) config.promptTemplate = values.promptTemplate;
  return config;
}

export const openrouterLocalUIAdapter: UIAdapterModule = {
  type: "openrouter_local",
  label: "OpenRouter",
  parseStdoutLine: parseOpenRouterStdoutLine,
  ConfigFields: OpenRouterLocalConfigFields,
  buildAdapterConfig: buildOpenRouterConfig,
};
