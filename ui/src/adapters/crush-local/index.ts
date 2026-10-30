import type { UIAdapterModule } from "../types";
import { parseCrushStdoutLine } from "@paperclipai/adapter-crush-local/ui";
import { CrushLocalConfigFields } from "./config-fields";
import { buildCrushLocalConfig } from "@paperclipai/adapter-crush-local/ui";

export const crushLocalUIAdapter: UIAdapterModule = {
  type: "crush_local",
  label: "Crush (local)",
  parseStdoutLine: parseCrushStdoutLine,
  ConfigFields: CrushLocalConfigFields,
  buildAdapterConfig: buildCrushLocalConfig,
};
