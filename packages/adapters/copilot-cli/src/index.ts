export const type = "copilot_cli";
export const label = "GitHub Copilot (local)";

export const models = [
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "gpt-4.1", label: "GPT-4.1" },
  { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
  { id: "o3", label: "o3" },
  { id: "o4-mini", label: "o4-mini" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
];

export const agentConfigurationDoc = `# copilot_cli agent configuration

Adapter: copilot_cli

Runs the GitHub Copilot CLI (\`gh copilot\`) as the agent execution backend.
The agent uses \`gh copilot\` to interact with code, create pull requests,
and manage GitHub resources.

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to stdin prompt at runtime
- model (string, optional): model id to pass via --model
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "gh"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Requires \`gh\` CLI with Copilot extension installed (\`gh extension install github/gh-copilot\`).
- Prompts are piped via stdin.
- Paperclip auto-injects local skills into the Copilot instructions directory when available.
- Set GITHUB_TOKEN in adapter env for authentication.
`;
