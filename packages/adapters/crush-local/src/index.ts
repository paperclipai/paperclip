export const type = "crush_local";
export const label = "Crush (local)";

// Crush owns the provider catalog. The UI permits a custom model ID and a
// blank value uses Crush's configured default.
export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# crush_local agent configuration

Adapter: crush_local

Use when:
- You want Paperclip to run the Crush CLI locally on the host machine
- You need a lightweight agent that can run tasks using Crush's built-in tool suite
- You want session persistence across heartbeats (Crush supports --session resumption)

Don't use when:
- You need structured JSON streaming output for rich run viewer transcripts (use claude_local)
- You need webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- Crush CLI is not installed on the machine that runs Paperclip

Core fields:
- cwd (string, optional): absolute working directory for the agent process (created if missing)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template with {{context.*}} interpolation
- model (string, optional): model in provider/model format (e.g. nvidia/model-id). Defaults to Crush's configured default.
- command (string, optional): path to crush binary. Defaults to "crush".
- extraArgs (string[], optional): additional CLI args appended to "crush run"
- env (object, optional): KEY=VALUE environment variables injected into the agent process

Operational fields:
- timeoutSec (number, optional): run timeout in seconds (0 = no timeout)
- graceSec (number, optional): SIGTERM grace period in seconds (default: 15)

Notes:
- Prompts are passed to Crush as a positional argument to \`crush run\`; output is plain text.
- Sessions resume with --session <id> when stored session cwd matches the current cwd.
- Paperclip links selected skills in an agent-specific directory under \`~/.paperclip/crush/\` and passes it through \`CRUSH_SKILLS_DIR\`.
- Crush runs non-interactively. Configure tool permissions in Crush for unattended work.
- Token usage and cost are not available from the Crush CLI output.
`;
