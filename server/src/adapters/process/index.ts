import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const processAdapter: ServerAdapterModule = {
  type: "process",
  execute,
  testEnvironment,
  supportsLocalAgentJwt: true,
  models: [],
  agentConfigurationDoc: `# process agent configuration

Adapter: process

Core fields:
- command (string, required): command to execute
- args (string[] | string, optional): command arguments
- cwd (string, optional): absolute working directory
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
- injectPaperclipRunAuth (boolean, optional, default false): when true, Paperclip injects
  PAPERCLIP_API_KEY and PAPERCLIP_RUN_ID for this run so trusted local processes can
  call the local Paperclip API as the assigned agent/run. Leave false for untrusted
  commands or commands that do not need to write back to Paperclip.
`,
};
