import { t } from "@/i18n";
import type { UIAdapterModule } from "../types";
import { parseCursorStdoutLine } from "@paperclipai/adapter-cursor-local/ui";
import { CursorLocalConfigFields } from "./config-fields";
import { buildCursorLocalConfig } from "@paperclipai/adapter-cursor-local/ui";

export const cursorLocalUIAdapter: UIAdapterModule = {
  type: "cursor",
  get label() { return t("agent-config:cursor_2239943"); },
  parseStdoutLine: parseCursorStdoutLine,
  ConfigFields: CursorLocalConfigFields,
  buildAdapterConfig: buildCursorLocalConfig,
};
