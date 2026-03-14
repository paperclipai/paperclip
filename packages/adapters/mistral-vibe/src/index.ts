export const type = "mistral_vibe";
export const label = "Mistral Vibe (local)";

export const models = [
  { id: "mistral-2", label: "Mistral 2 (123B)" },
  { id: "mistral-small-2", label: "Mistral Small 2 (24B)" },
];

export const agentConfigurationDoc = `# mistral_vibe agent configuration

Adapter: mistral_vibe

Use when:
- The agent needs to run Mistral Vibe CLI locally on the host machine
- You need session persistence across runs (Mistral Vibe supports thread resumption)
- The task requires Mistral Vibe-specific tools (e.g. web search, code execution, version control)
- You want to leverage the full 123B parameter Mistral 2 model or the lightweight 24B Mistral Small 2 model

Don't use when:
- You need a simple one-shot script execution (use the "process" adapter instead)
- The agent doesn't need conversational context between runs (process adapter is simpler)
- Mistral Vibe CLI is not installed on the host
- You need API-based access instead of local CLI execution

Core fields:
- cwd (string, required): absolute working directory for the agent process
- model (string, optional): Mistral Vibe model id (devstral-2 or devstral-small-2)
- timeoutSec (number, optional): run timeout in seconds (default: 0 = no timeout)
- graceSec (number, optional): SIGTERM grace period in seconds (default: 15)
- env (object, optional): KEY=VALUE environment variables
- command (string, optional): defaults to "devstral-vibe"
- extraArgs (string[], optional): additional CLI args

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
`;