import type { UIAdapterModule } from "../types";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { DashScopeLocalConfigFields } from "./config-fields";

function parseDashScopeStdoutLine(line: string, ts: string) {
  return [{ kind: "stdout" as const, ts, text: line }];
}

function buildDashScopeLocalConfig(values: CreateConfigValues) {
  const result: Record<string, unknown> = {
    model: values.model || "qwen3.5-plus",
  };
  
  // Add optional fields if present
  if (values.extraArgs !== undefined) {
    result.extraArgs = values.extraArgs;
  }
  if (values.instructionsFilePath !== undefined) {
    result.instructionsFilePath = values.instructionsFilePath;
  }
  
  return result;
}

export const dashscopeLocalUIAdapter: UIAdapterModule = {
  type: "dashscope_local",
  label: "阿里云百炼 (DashScope)",
  parseStdoutLine: parseDashScopeStdoutLine,
  ConfigFields: DashScopeLocalConfigFields,
  buildAdapterConfig: buildDashScopeLocalConfig,
};
