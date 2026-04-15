import type { UIAdapterModule } from "../types";
import { parseDashScopeStdoutLine, buildDashScopeLocalConfig } from "@paperclipai/adapter-dashscope-local/ui";
import { DashScopeLocalConfigFields } from "./config-fields";

export const dashscopeLocalUIAdapter: UIAdapterModule = {
  type: "dashscope_local",
  label: "阿里云百炼 (DashScope)",
  parseStdoutLine: parseDashScopeStdoutLine,
  ConfigFields: DashScopeLocalConfigFields,
  buildAdapterConfig: buildDashScopeLocalConfig,
};
