import type { UIAdapterModule, AdapterConfigFieldsProps } from "../types";
import { createDefaultConfigFields } from "../default-config-fields";

function DashScopeConfigFields({ values, set, config, eff, mark, models }: AdapterConfigFieldsProps) {
  return createDefaultConfigFields({
    values,
    set,
    config,
    eff,
    mark,
    models,
    defaultModel: "qwen3.5-plus",
    apiKeyName: "DASHSCOPE_API_KEY",
    adapterLabel: "阿里云百炼 (DashScope)",
    notes: [
      "Requires DASHSCOPE_API_KEY environment variable",
      "API endpoint: https://coding.dashscope.aliyuncs.com/v1/chat/completions (OpenAI-compatible)",
      "Uses OpenAI-compatible API format (阿里云百炼专属套餐)",
    ],
  });
}

export const dashscopeLocalUIAdapter: UIAdapterModule = {
  type: "dashscope_local",
  label: "阿里云百炼 (DashScope)",
  parseStdoutLine: (line: string, ts: string) => {
    return [{ type: "stdout", ts, text: line }];
  },
  ConfigFields: DashScopeConfigFields,
  buildAdapterConfig: (values) => {
    return {
      model: values.model || "qwen3.5-plus",
      temperature: values.temperature ?? 0.7,
      topP: values.topP ?? 0.8,
      maxTokens: values.maxTokens ?? 0,
      timeoutSec: values.timeoutSec ?? 120,
      env: values.env || {},
    };
  },
};
