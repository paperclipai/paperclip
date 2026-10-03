import type { UIAdapterModule } from "../types";
import { parseBobShellStdoutLine, buildBobShellConfig } from "@paperclipai/adapter-bob-shell/ui";
import { SchemaConfigFields } from "../schema-config-fields";

export const bobShellUIAdapter: UIAdapterModule = {
  type: "bob_shell",
  label: "IBM Bob",
  parseStdoutLine: parseBobShellStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildBobShellConfig,
};
