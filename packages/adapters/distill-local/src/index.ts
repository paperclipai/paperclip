export const type = "distill_local";
export const label = "Distill";
export const DEFAULT_DISTILL_LOCAL_MODEL = "auto";
export const models = [
  { id: DEFAULT_DISTILL_LOCAL_MODEL, label: "Auto (Distill account routing)" },
  { id: "claude/claude-sonnet-5-5", label: "claude/claude-sonnet-5-5" },
  { id: "claude/claude-opus-5-5", label: "claude/claude-opus-5-5" },
  { id: "chatgpt/gpt-6.1-sol", label: "chatgpt/gpt-6.1-sol" },
];
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
export const EXECUTION_MODES = ["auto", "normal", "ultrafast", "ultracode", "ultrasave"];

export const agentConfigurationDoc = `# distill_local agent configuration

Adapter: distill_local

Use when:
- You want Paperclip to run the Distill coding agent CLI on the host machine
- You want every model Distill knows (Claude, ChatGPT, OpenRouter, Z.AI, custom models) or Distill's saved-account auto routing
- You want resumable Distill sessions across heartbeats via \`--resume\`

Don't use when:
- The agent must run in a remote sandbox (this adapter runs Distill locally only)
- Distill is not installed or has no logged-in account on the Paperclip host

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file. Staged as \`Agents.md\` in the workspace when free, otherwise prepended to the prompt.
- promptTemplate (string, optional): run prompt template
- model (string, optional): Distill model id. Defaults to "auto", which routes across the saved accounts by remaining quota. Any id printed by \`distill models\` works.
- reasoningEffort (string, optional): passed via \`--reasoning-effort\` (none|minimal|low|medium|high|xhigh|max; support depends on the model)
- mode (string, optional): Distill execution mode via \`--mode\` (auto|normal|ultrafast|ultracode|ultrasave)
- maxTurns (number, optional): maximum agent turns for the run
- permissionMode (string, optional): passed via \`--permission-mode\`; unset by default
- alwaysApprove (boolean, optional): adds \`--always-approve\` so unattended runs never wait for approval. Default true.
- disableWebSearch (boolean, optional): adds \`--disable-web-search\`. Default false.
- trustWorkspace (boolean, optional): sets GROK_FOLDER_TRUST=0 so Distill loads project instructions and skills from the Paperclip workspace without an interactive trust prompt. Default true.
- command (string, optional): defaults to "distill"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables (for example DISTILL_HOME or provider API keys)

Operational fields:
- timeoutSec (number, optional): run timeout in seconds (0 = none)
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use \`distill --single\` with \`--output-format streaming-json\`.
- Accounts and models come from the Distill home of the user running Paperclip (\`~/.distill\`). Use \`distill accounts list\` and \`distill models\` on the host to inspect them.
- Paperclip stages desired runtime skills into \`.claude/skills\` inside the workspace so Distill discovers them as project skills.
`;
