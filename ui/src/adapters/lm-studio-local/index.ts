import type { UIAdapterModule } from "../types";
import { parseCodexStdoutLine } from "@paperclipai/adapter-codex-local/ui";
import { LmStudioLocalConfigFields } from "./config-fields";
import { buildLmStudioLocalConfig } from "@paperclipai/adapter-lm-studio-local/ui";

export const lmStudioLocalUIAdapter: UIAdapterModule = {
  type: "lm_studio_local",
  label: "LM Studio (local)",
  parseStdoutLine: parseCodexStdoutLine,
  ConfigFields: LmStudioLocalConfigFields,
  buildAdapterConfig: buildLmStudioLocalConfig,
};
