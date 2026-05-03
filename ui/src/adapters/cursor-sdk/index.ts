import type { UIAdapterModule } from "../types";
import { parseCursorSdkStdoutLine, buildCursorSdkConfig } from "@paperclipai/adapter-cursor-sdk/ui";
import { CursorSdkConfigFields } from "./config-fields";

export const cursorSdkUIAdapter: UIAdapterModule = {
  type: "cursor_sdk",
  label: "Cursor SDK",
  parseStdoutLine: parseCursorSdkStdoutLine,
  ConfigFields: CursorSdkConfigFields,
  buildAdapterConfig: buildCursorSdkConfig,
};
