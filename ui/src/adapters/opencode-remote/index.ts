import type { UIAdapterModule } from "../types";
import { parseOpenCodeRemoteStdoutLine } from "@paperclipai/adapter-opencode-remote/ui";
import { OpenCodeRemoteConfigFields } from "./config-fields";
import { buildOpenCodeRemoteConfig } from "@paperclipai/adapter-opencode-remote/ui";

export const openCodeRemoteUIAdapter: UIAdapterModule = {
  type: "opencode_remote",
  label: "OpenCode (remote)",
  parseStdoutLine: parseOpenCodeRemoteStdoutLine,
  ConfigFields: OpenCodeRemoteConfigFields,
  buildAdapterConfig: buildOpenCodeRemoteConfig,
};
