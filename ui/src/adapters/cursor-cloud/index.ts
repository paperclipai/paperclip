import type { UIAdapterModule } from "../types";
import { SchemaConfigFields } from "../schema-config-fields";
import {
  buildCursorCloudConfig,
  parseCursorCloudStdoutLine,
} from "@paperclipai/adapter-cursor-cloud/ui";

export const cursorCloudUIAdapter: UIAdapterModule = {
  type: "cursor_cloud",
  label: "Cursor Cloud",
  parseStdoutLine: parseCursorCloudStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildCursorCloudConfig,
};
