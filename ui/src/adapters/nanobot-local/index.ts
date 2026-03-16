import type { UIAdapterModule } from "../types";
import { parseNanobotLocalStdoutLine } from "@paperclipai/adapter-nanobot-local/ui";
import { buildNanobotLocalConfig } from "@paperclipai/adapter-nanobot-local/ui";
import { NanobotLocalConfigFields } from "./config-fields";

export const nanobotLocalUIAdapter: UIAdapterModule = {
  type: "nanobot_local",
  label: "Nanobot Local",
  parseStdoutLine: parseNanobotLocalStdoutLine,
  ConfigFields: NanobotLocalConfigFields,
  buildAdapterConfig: buildNanobotLocalConfig,
};
