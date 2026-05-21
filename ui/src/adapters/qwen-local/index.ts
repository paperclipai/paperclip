import type { UIAdapterModule } from "../types";
import { parseProcessStdoutLine } from "../process/parse-stdout";
import { SchemaConfigFields, buildSchemaAdapterConfig } from "../schema-config-fields";

export const DEFAULT_QWEN_LOCAL_MODEL = "qwen3.6-plus";

export const qwenLocalUIAdapter: UIAdapterModule = {
  type: "qwen_local",
  label: "Qwen Code (local)",
  parseStdoutLine: parseProcessStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildSchemaAdapterConfig,
};
