import type { UIAdapterModule, CreateConfigValues } from "../types";
import { parseDashScopeStdoutLine } from "@paperclipai/adapter-dashscope-local/ui";
import { DashScopeLocalConfigFields } from "./config-fields";

function buildDashScopeLocalConfig(values: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (values.model) ac.model = values.model;
  if (values.baseUrl) ac.baseUrl = values.baseUrl;
  if (values.temperature !== undefined) ac.temperature = values.temperature;
  if (values.topP !== undefined) ac.topP = values.topP;
  if (values.maxTokens !== undefined) ac.maxTokens = values.maxTokens;
  if (values.timeoutSec !== undefined) ac.timeoutSec = values.timeoutSec;
  if (values.graceSec !== undefined) ac.graceSec = values.graceSec;
  if (values.env && Object.keys(values.env).length > 0) ac.env = values.env;
  return ac;
}

export const dashscopeLocalUIAdapter: UIAdapterModule = {
  type: "dashscope_local",
  label: "阿里云百炼 (DashScope)",
  parseStdoutLine: parseDashScopeStdoutLine,
  ConfigFields: DashScopeLocalConfigFields,
  buildAdapterConfig: buildDashScopeLocalConfig,
};
