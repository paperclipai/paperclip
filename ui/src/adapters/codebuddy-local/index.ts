import type { UIAdapterModule } from "../types";
import { parseProcessStdoutLine } from "../process/parse-stdout";
import { SchemaConfigFields, buildSchemaAdapterConfig } from "../schema-config-fields";

export const DEFAULT_CODEBUDDY_LOCAL_MODEL = "V-glm-5.1";

export const codebuddyLocalUIAdapter: UIAdapterModule = {
  type: "codebuddy_local",
  label: "CodeBuddy Code (local)",
  parseStdoutLine: parseProcessStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildSchemaAdapterConfig,
};
