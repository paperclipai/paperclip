import type { UIAdapterModule } from "../types";
import { isAgyStreamingTextDelta, parseAgyStdoutLine, buildAgyConfig } from "@paperclipai/adapter-agy-local/ui";
import { AgyLocalConfigFields } from "./config-fields";

export const agyLocalUIAdapter: UIAdapterModule = {
  type: "agy_local",
  label: "Antigravity (agy)",
  parseStdoutLine: parseAgyStdoutLine,
  isStreamingTextDelta: isAgyStreamingTextDelta,
  ConfigFields: AgyLocalConfigFields,
  buildAdapterConfig: buildAgyConfig,
};
