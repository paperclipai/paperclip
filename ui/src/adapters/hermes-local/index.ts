import type { UIAdapterModule } from "../types";
import {
  parseHermesStdoutLine,
  createStdoutParser,
  buildHermesConfig,
} from "@paperclipai/hermes-paperclip-adapter/ui";
import { SchemaConfigFields } from "../schema-config-fields";

export const hermesLocalUIAdapter: UIAdapterModule = {
  type: "hermes_local",
  label: "Hermes",
  parseStdoutLine: parseHermesStdoutLine,
  // Fresh parser per transcript build so Reasoning-box state resets instead
  // of leaking across runs.
  createStdoutParser,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildHermesConfig,
};
