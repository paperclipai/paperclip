import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const httpAdapter: ServerAdapterModule = {
  type: "http",
  runtimeToolDelivery: "invocation_context",
  execute,
  testEnvironment,
  models: [],
  agentConfigurationDoc: `# http agent configuration

Adapter: http

Core fields:
- url (string, required): endpoint to invoke
- method (string, optional): HTTP method, default POST
- headers (object, optional): request headers
- payloadTemplate (object, optional): JSON payload template
- timeoutSec (number, optional): request timeout in seconds
- timeoutMs (number, optional): request timeout in milliseconds; takes precedence over timeoutSec
- runAttestation (boolean, optional): sign a receiver-scoped, 120-second Ed25519
  run attestation in x-paperclip-run-attestation. Requires an HTTPS URL, an
  issue-scoped run, and PAPERCLIP_HTTP_RUN_ATTESTATION_KEY_FILE on the server.
  The receiver must pin the public key and reject replayed jti values.
`,
};
