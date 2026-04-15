import type { UIAdapterModule, CreateConfigValues } from "../types";
import { parseDashScopeStdoutLine } from "@paperclipai/adapter-dashscope-local/ui";
import { DashScopeLocalConfigFields } from "./config-fields";

function buildDashScopeLocalConfig(values: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (values.model) ac.model = values.model;
  
  // Default baseUrl to Coding Plan endpoint
  const defaultBaseUrl = "https://coding.dashscope.aliyuncs.com/v1";
  ac.baseUrl = values.baseUrl || defaultBaseUrl;
  
  // Handle environment variables from envVars string (create mode)
  if (values.envVars && values.envVars.trim()) {
    const env: Record<string, { type: "plain"; value: string }> = {};
    values.envVars.split(/\r?\n/).forEach((line: string) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const eq = trimmed.indexOf("=");
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value) {
          env[key] = { type: "plain", value };
        }
      }
    });
    if (Object.keys(env).length > 0) ac.env = env;
  }
  
  return ac;
}

export const dashscopeLocalUIAdapter: UIAdapterModule = {
  type: "dashscope_local",
  label: "阿里云百炼 (DashScope)",
  parseStdoutLine: parseDashScopeStdoutLine,
  ConfigFields: DashScopeLocalConfigFields,
  buildAdapterConfig: buildDashScopeLocalConfig,
};
