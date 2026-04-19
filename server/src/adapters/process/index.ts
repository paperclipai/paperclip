import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const processAdapter: ServerAdapterModule = {
  type: "process",
  execute,
  testEnvironment,
  models: [],
  agentConfigurationDoc: `# process agent configuration

Adapter: process

Core fields:
- command (string, required): command to execute
- args (string[] | string, optional): command arguments
- cwd (string, optional): absolute working directory
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): wall-clock run timeout in seconds (from spawn); 0 disables when maxWallClockSec is omitted
- maxWallClockSec (number, optional): explicit wall-clock ceiling; when set (including 0), overrides the wall watchdog source from timeoutSec alone
- idleTimeoutSec (number, optional): kill if no stdout/stderr for this many seconds; 0 disables
- graceSec (number, optional): SIGTERM grace period in seconds
`,
};
