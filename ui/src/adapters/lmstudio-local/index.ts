import type { UIAdapterModule } from "../types";
import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { LmStudioLocalConfigFields } from "./config-fields";

/**
 * Parse stdout lines from an LM Studio-backed agent.
 * LM Studio itself doesn't produce stdout (it's an HTTP API), so this is
 * a minimal passthrough that wraps every line as an assistant message.
 */
function parseLmStudioStdoutLine(line: string, ts: string): TranscriptEntry[] {
  if (!line.trim()) return [];
  return [{ kind: "assistant", text: line, ts }];
}

function buildLmStudioConfig(values: CreateConfigValues): Record<string, unknown> {
  return {
    apiBaseUrl: values.url || "http://localhost:1234/v1",
    apiKey: (values.envBindings?.LMSTUDIO_API_KEY as string) || "lm-studio",
    model: values.model || "",
    instructionsFilePath: values.instructionsFilePath || undefined,
  };
}

export const lmstudioLocalUIAdapter: UIAdapterModule = {
  type: "lmstudio_local",
  label: "LM Studio",
  parseStdoutLine: parseLmStudioStdoutLine,
  ConfigFields: LmStudioLocalConfigFields,
  buildAdapterConfig: buildLmStudioConfig,
};
