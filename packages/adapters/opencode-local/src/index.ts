export const type = "opencode_local";
export const label = "OpenCode (local)";

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# opencode_local agent configuration

Adapter: opencode_local

Use when:
- You want Paperclip to run OpenCode locally as the agent runtime
- You want provider/model routing in OpenCode format (provider/model)
- You want OpenCode session resume across heartbeats via --session

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- OpenCode CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- agent (string, optional): OpenCode agent profile name from \`agent.<name>\` in \`opencode.json\`; passed as \`opencode run --agent <name>\`
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- model (string, optional): OpenCode model id in provider/model format (for example anthropic/claude-sonnet-4-5)
- variant (string, optional): provider-specific model variant (for example minimal|low|medium|high|max)
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "opencode"; Paperclip also auto-detects common local installs such as ~/.opencode/bin/opencode
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- OpenCode supports multiple providers and models. Use \
  \`opencode models\` to list available options in provider/model format.
- OpenCode agent profiles can be listed with \`opencode agent list\`; Paperclip also reads \`agent\` / \`default_agent\` from \`~/.config/opencode/opencode.json\` (and \`.jsonc\`) as a fallback source.
- Paperclip also reads \`~/.config/opencode/opencode.json\` (and \`.jsonc\`) as a fallback source for configured custom provider models.
- Configure at least one of \`model\` or \`agent\`. If both are set, Paperclip passes both \`--agent\` and \`--model\`, so the explicit model can still override the agent profile's default model.
- Runs are executed with: opencode run --format json ...
- Sessions are resumed with --session when stored session cwd matches current cwd.
`;
