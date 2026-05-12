import type { UIAdapterModule } from "../types";
import { parseProcessStdoutLine } from "../process/parse-stdout";
import { SchemaConfigFields, buildSchemaAdapterConfig } from "../schema-config-fields";

// OpenSwarm subprocess output is human-readable banner + tool spinners; the
// process-style stdout parser ("plain text line per timestamp") is the right
// default. If unohee or VRSEN ever emit structured JSONL we can swap in a
// dedicated parser then.
export const openswarmLocalUIAdapter: UIAdapterModule = {
  type: "openswarm_local",
  label: "OpenSwarm",
  parseStdoutLine: parseProcessStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildSchemaAdapterConfig,
};
