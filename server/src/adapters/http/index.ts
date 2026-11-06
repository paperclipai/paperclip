import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const httpAdapter: ServerAdapterModule = {
  type: "http",
  runtimeToolDelivery: "invocation_context",
  execute,
  testEnvironment,
  models: [],
  // Lets this agent's run carry the same run JWT already minted for local
  // adapters, so it can be forwarded in the POST body when forwardAuthToken
  // is set. Minting alone changes nothing: execute() only puts it on the
  // wire when the agent's own config opts in.
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: `# http agent configuration

Adapter: http

Core fields:
- url (string, required): endpoint to invoke
- method (string, optional): HTTP method, default POST
- headers (object, optional): request headers
- payloadTemplate (object, optional): JSON payload template
- timeoutSec (number, optional): request timeout in seconds
- forwardAuthToken (boolean, optional, default false): when true, the POST
  body carries an "authToken" field with this run's agent JWT, the same
  token issued to local adapters, scoped to this agent and this run only.
`,
};
