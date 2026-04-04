import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const pollAdapter: ServerAdapterModule = {
  type: "poll",
  execute,
  testEnvironment,
  models: [],
  agentConfigurationDoc: `# poll agent configuration

Adapter: poll

No configuration required. The agent manages its own execution lifecycle
by polling the Paperclip API for tasks, checking out issues, and reporting
results back via API calls.
`,
};
