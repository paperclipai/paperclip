export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { sessionCodec } from "./session.js";

import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import { DEFAULT_QODER_API_BASE_URL } from "../index.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "apiBaseUrl",
        label: "Qoder API base URL",
        type: "text",
        default: DEFAULT_QODER_API_BASE_URL,
        hint: "Use https://api.qoder.com.cn for the China region. Must match the access token's region.",
      },
      {
        key: "qoderAgentId",
        label: "Qoder agent ID",
        type: "text",
        hint: "Optional existing Qoder agent (agent_...). Leave empty to let Paperclip create and reuse one.",
      },
      {
        key: "environmentId",
        label: "Qoder environment ID",
        type: "text",
        hint: "Optional Qoder environment (env_...). Leave empty to use the account's first Qoder-hosted (cloud) environment.",
      },
      {
        key: "repoUrl",
        label: "Repository URL",
        type: "text",
        hint: "Optional http(s) Git repository Qoder should clone into the session.",
      },
      {
        key: "repoStartingRef",
        label: "Starting branch",
        type: "text",
        hint: "Optional branch Qoder should check out.",
      },
      {
        key: "repoMountPath",
        label: "Repository mount path",
        type: "text",
        hint: "Optional clone path inside the container. Defaults to /data/workspace/<repo>.",
      },
      {
        key: "timeoutSec",
        label: "Turn timeout (seconds)",
        type: "number",
        default: 0,
        hint: "Cancel the Qoder turn after this many seconds. 0 disables the limit.",
      },
    ],
  };
}
