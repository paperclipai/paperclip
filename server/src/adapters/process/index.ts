import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const processAdapter: ServerAdapterModule = {
  type: "process",
  execute,
  testEnvironment,
  models: [],
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: `# process agent configuration

Adapter: process

Core fields:
- command (string, required): command to execute
- args (string[] | string, optional): command arguments
- cwd (string, optional): absolute working directory
- env (object, optional): KEY=VALUE environment variables
- PAPERCLIP_API_KEY and PAPERCLIP_RUN_ID are injected for local authenticated Paperclip API writes when the server can mint a scoped run JWT

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
`,
};
