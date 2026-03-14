export const type = "kiro_local";
export const label = "Kiro CLI (local)";

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# kiro_local agent configuration

Adapter: kiro_local

Use when:
- You want Paperclip to run Kiro CLI locally as the agent runtime
- You want session resume across heartbeats via --resume
- You need Kiro CLI's built-in tools (read, write, shell, grep, glob, aws, web_search, code, etc.)

Don't use when:
- You need structured JSON streaming output (Kiro CLI outputs plain text)
- Kiro CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the prompt at runtime
- promptTemplate (string, optional): run prompt template
- trustAllTools (boolean, optional): pass --trust-all-tools when running Kiro CLI (default: true)
- command (string, optional): defaults to "kiro-cli"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Kiro CLI uses --no-interactive mode for headless execution.
- Sessions are directory-based; --resume resumes the most recent session in the working directory.
- Output is plain text; token/cost tracking is best-effort via regex parsing of credit usage lines.
- Kiro CLI uses Auto model selection by default.
`;
