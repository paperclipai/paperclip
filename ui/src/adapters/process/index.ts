import type { UIAdapterModule } from "../types";
import { parseProcessStdoutLine, createProcessStdoutParser } from "./parse-stdout";
import { ProcessConfigFields } from "./config-fields";
import { buildProcessConfig } from "./build-config";

export const processUIAdapter: UIAdapterModule = {
  type: "process",
  label: "Shell Process",
  parseStdoutLine: parseProcessStdoutLine,
  createStdoutParser: createProcessStdoutParser,
  ConfigFields: ProcessConfigFields,
  buildAdapterConfig: buildProcessConfig,
};
