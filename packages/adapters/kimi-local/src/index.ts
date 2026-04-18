export const type = "kimi_local";
export const label = "Kimi Code CLI (local)";

export const models = [
  { id: "kimi-k2-0713", label: "Kimi K2" },
  { id: "kimi-k2-0713-thinking", label: "Kimi K2 (Thinking)" },
  { id: "kimi-k2-0713-lite", label: "Kimi K2 Lite" },
];

export const agentConfigurationDoc = `# kimi_local agent configuration

Adapter: kimi_local

Use when:
- The agent needs to run Kimi Code CLI locally on the host machine
- You prefer Moonshot AI's Kimi models over other providers
- You need session persistence across runs (Kimi supports session resumption)
- You need a cost-effective alternative to Claude or OpenAI models

Don't use when:
- Kimi Code CLI is not installed on the host machine
- You need specific Claude-only features (like computer use with Chrome)
- You prefer API-key based authentication over login-based

Core fields:
- cwd (string, optional): default absolute working directory for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file
- model (string, optional): Kimi model id (e.g., "kimi-k2-0713")
- thinking (boolean, optional): enable thinking mode
- promptTemplate (string, optional): run prompt template
- maxStepsPerTurn (number, optional): max steps per turn
- maxRetriesPerStep (number, optional): max retries per step
- yolo (boolean, optional, default true): auto-approve all actions (equivalent to --yolo)
- command (string, optional): defaults to "kimi"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Kimi CLI uses ".kimi" directory for session storage (similar to .claude)
- Session resumption uses --session or --continue flags
- Output format is stream-json with role-based messages
`;
