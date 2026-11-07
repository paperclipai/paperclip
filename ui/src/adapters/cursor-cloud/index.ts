import { t } from "@/i18n";
import type { UIAdapterModule } from "../types";
import { SchemaConfigFields } from "../schema-config-fields";
import {
  buildCursorCloudConfig,
  parseCursorCloudStdoutLine,
} from "@paperclipai/adapter-cursor-cloud/ui";

export const cursorCloudUIAdapter: UIAdapterModule = {
  type: "cursor_cloud",
  get label() { return t("agent-config:cursorCloud_48e09b3"); },
  parseStdoutLine: parseCursorCloudStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildCursorCloudConfig,
};
