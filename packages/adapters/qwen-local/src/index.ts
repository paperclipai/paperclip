export const type = "qwen_local";
export const label = "Qwen Code (local)";

export const models = [
  { id: "qwen3-coder-plus", label: "qwen3-coder-plus" },
  { id: "qwen3-coder-next", label: "qwen3-coder-next" },
  { id: "qwen3.5-plus", label: "qwen3.5-plus" },
];

export const agentConfigurationDoc = `# qwen_local agent configuration

Adapter: qwen_local

Use when:
- You want Paperclip to run Qwen Code locally as the agent runtime
- You want JSON event streaming via \`--output-format stream-json\`
- You want Qwen session resume across heartbeats via \`--resume\`

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- Qwen Code CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- model (string, optional): Qwen model id override
- yolo (boolean, optional): pass \`--yolo\` to auto-approve actions
- approvalMode (string, optional): pass \`--approval-mode\`
- maxSessionTurns (number, optional): pass \`--max-session-turns\`
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "qwen"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables (for example \`DASHSCOPE_API_KEY\`)

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs are executed with: \`qwen -p "<prompt>" --output-format stream-json ...\`
- Sessions are resumed with \`--resume\` when stored session cwd matches current cwd.
- The adapter warns when no obvious auth env is configured, but does not hard-fail because local OAuth login may still work.
`;
