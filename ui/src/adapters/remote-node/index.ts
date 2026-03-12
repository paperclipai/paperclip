import type { UIAdapterModule } from "../types";
import { parseRemoteNodeStdoutLine, buildRemoteNodeConfig } from "@paperclipai/adapter-remote-node/ui";
import { RemoteNodeConfigFields } from "./config-fields";

export const remoteNodeUIAdapter: UIAdapterModule = {
  type: "remote_node",
  label: "Remote Node",
  parseStdoutLine: parseRemoteNodeStdoutLine,
  ConfigFields: RemoteNodeConfigFields,
  buildAdapterConfig: buildRemoteNodeConfig,
};
