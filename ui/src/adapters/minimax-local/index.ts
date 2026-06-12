import type { UIAdapterModule } from "../types";
import { parseMiniMaxLocalStdoutLine, buildMiniMaxLocalConfig } from "@paperclipai/adapter-minimax-local/ui";
import { MiniMaxLocalConfigFields } from "./config-fields";

export const minimaxLocalUIAdapter: UIAdapterModule = {
  type: "minimax_local",
  label: "MiniMax Local",
  parseStdoutLine: parseMiniMaxLocalStdoutLine,
  ConfigFields: MiniMaxLocalConfigFields,
  buildAdapterConfig: buildMiniMaxLocalConfig,
};
