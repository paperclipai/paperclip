import type { UIAdapterModule } from "../types";
import { parseKiroStdoutLine } from "@paperclipai/adapter-kiro-local/ui";
import { KiroLocalConfigFields } from "./config-fields";
import { buildKiroLocalConfig } from "@paperclipai/adapter-kiro-local/ui";

export const kiroLocalUIAdapter: UIAdapterModule = {
  type: "kiro_local",
  label: "Kiro CLI (local)",
  parseStdoutLine: parseKiroStdoutLine,
  ConfigFields: KiroLocalConfigFields,
  buildAdapterConfig: buildKiroLocalConfig,
};
