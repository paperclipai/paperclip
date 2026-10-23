import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const processAdapter: ServerAdapterModule = {
  type: "process",
  runtimeToolDelivery: "environment",
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

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
- fixedCommand (boolean, optional, default false): restrict permanent API keys
  to POST /api/agents/<id>/wakeup or /heartbeat/invoke with an empty body or
  only idempotencyKey. Query parameters, task payloads, configuration changes,
  and other API requests are denied, except GET /api/agents/<id> for status
  reconciliation after an uncertain trigger outcome. This is opt-in for trusted service
  commands; normal process agents keep their existing API access. The command
  receives its normal run-scoped JWT; active-run secret checks remain required.
  Configure the executable and its environment administratively, and do not
  expose the run JWT through command output or an untrusted input channel.
`,
};
