import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const cloudSandboxAdapter: ServerAdapterModule = {
  type: "cloud_sandbox",
  execute,
  testEnvironment,
  supportsLocalAgentJwt: true,
  models: [],
  agentConfigurationDoc: `# cloud_sandbox agent configuration

Adapter: cloud_sandbox

Runs agent CLIs in isolated Kubernetes pods. Requires cloud sandbox to be enabled on the instance.

Core fields:
- runtime (string, optional): agent runtime — "claude" (recommended), "codex", "opencode", "gemini", "pi" (default: "claude")
- model (string, optional): model override passed to the runtime CLI
- runtimeImage (string, optional): container image for the sandbox pod
- isolation (string, optional): "shared" (one pod per company) or "isolated" (one pod per agent)
- env (object, optional): KEY=VALUE environment variables injected into the pod

Operational fields:
- timeoutSec (number, optional): execution timeout in seconds (default: 600)
- resources (object, optional): { cpu, memory } resource requests/limits for the pod
`,
};
