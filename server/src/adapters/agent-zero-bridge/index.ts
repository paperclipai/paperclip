import type { ServerAdapterModule } from "../types.js";
import { executeAgentZeroBridge } from "./execute.js";
import { getAgentZeroBridgeConfigSchema } from "./config.js";
import { testAgentZeroBridgeEnvironment } from "./test.js";

export const agentZeroBridgeAdapter: ServerAdapterModule = {
  type: "agent_zero_bridge",
  execute: executeAgentZeroBridge,
  testEnvironment: testAgentZeroBridgeEnvironment,
  getConfigSchema: getAgentZeroBridgeConfigSchema,
  agentConfigurationDoc: [
    "Use Agent Zero Bridge when Paperclip should hand off the current wake payload to an external Agent Zero worker over HTTP.",
    "The bridge contract is intentionally fire-and-forget: Paperclip posts to /invoke, the bridge checks out the issue, talks to Agent Zero, and reports status/comments back asynchronously.",
    "Pair this adapter with the bundled examples/bridges/a0-paperclip-bridge companion if you want a ready-to-run local bridge.",
  ].join(" "),
};
