import type { UIAdapterModule, TranscriptEntry } from "../types";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { LmStudioLocalConfigFields } from "./config-fields";

function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}

function buildAdapterConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url) ac.baseUrl = v.url;
  if (v.model) ac.model = v.model;
  if (v.promptTemplate) ac.systemPrompt = v.promptTemplate;
  ac.timeoutMs = 120_000;
  return ac;
}

export const lmstudioLocalUIAdapter: UIAdapterModule = {
  type: "lmstudio_local",
  label: "LM Studio (Local)",
  parseStdoutLine,
  ConfigFields: LmStudioLocalConfigFields,
  buildAdapterConfig,
};
