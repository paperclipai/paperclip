import type { UIAdapterModule } from "../types";
import { buildQodoLocalConfig, parseQodoStdoutLine } from "@paperclipai/adapter-qodo-local/ui";
import { QodoLocalConfigFields } from "./config-fields";

export const qodoLocalUIAdapter: UIAdapterModule = {
  type: "qodo_local",
  label: "Qodo CLI (local)",
  parseStdoutLine: parseQodoStdoutLine,
  ConfigFields: QodoLocalConfigFields,
  buildAdapterConfig: buildQodoLocalConfig,
};
