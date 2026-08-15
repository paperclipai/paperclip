import type { UIAdapterModule } from "../types";
import { parseDeflectorStdoutLine } from "./parse-stdout";
import { DeflectorConfigFields } from "./config-fields";
import { buildDeflectorConfig } from "./build-config";

export const deflectorUIAdapter: UIAdapterModule = {
  type: "deflector_local",
  label: "Deflector",
  parseStdoutLine: parseDeflectorStdoutLine,
  ConfigFields: DeflectorConfigFields,
  buildAdapterConfig: buildDeflectorConfig,
};
