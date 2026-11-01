import { createServerAdapter } from "./server/index.js";

export const type = "muse_local";
export const label = "Muse Code";
export const DEFAULT_MUSE_LOCAL_MODEL = "muse-wonder-1.0";

export const models = [
  { id: DEFAULT_MUSE_LOCAL_MODEL, label: "Muse Wonder" },
  { id: "muse-wonder-full-1.0", label: "Muse Wonder Full" },
  { id: "muse-spark-1.3", label: "Muse Spark 1.3" },
];

export function museLocalReasoningEffortsForModel(model: string): readonly string[] {
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
}

export const agentConfigurationDoc = `# muse_local agent configuration

Adapter: muse_local

Use when:
- You want Paperclip to run Meta's Muse Code CLI locally on the host machine
- You want headlessly managed Muse sessions with subscription authentication
- You want automatic session resumption across heartbeats via \`--session-id\`

Don't use when:
- You need a webhook-style external invocation (use http or openclaw_gateway)
- Muse Code CLI is not installed or authenticated on the machine that runs Paperclip

Core fields:
- engine (string, optional): execution engine, "acp" (default) or "cli"
- agentCommand (string, optional): override for the Muse ACP server command (defaults to muse-acp)
- cwd (string, optional): default absolute working directory fallback for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file
- promptTemplate (string, optional): run prompt template
- model (string, optional): Muse model id (defaults to muse-wonder-1.0)
- reasoningEffort (string, optional): none|minimal|low|medium|high|xhigh|max|ultra (default: high)
- command (string, optional): defaults to "~/.local/bin/muse" or "muse"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
`;

export { createServerAdapter };
