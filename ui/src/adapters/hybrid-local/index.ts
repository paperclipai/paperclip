import type { UIAdapterModule } from "../types";
import { parseHybridStdoutLine } from "@paperclipai/adapter-hybrid-local/ui";
import { HybridLocalConfigFields } from "./config-fields";
import { buildHybridLocalConfig } from "@paperclipai/adapter-hybrid-local/ui";

export const hybridLocalUIAdapter: UIAdapterModule = {
  type: "hybrid_local",
  label: "Hybrid (local)",
  parseStdoutLine: parseHybridStdoutLine,
  ConfigFields: HybridLocalConfigFields,
  buildAdapterConfig: buildHybridLocalConfig,
};
