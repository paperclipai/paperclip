import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "pi_local";
export const label = "Pi";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @earendil-works/pi-coding-agent@0.74.0";

export const models: Array<{ id: string; label: string }> = [];

export const modelProfiles: AdapterModelProfileDefinition[] = [];

export const agentConfigurationDoc = `# pi_local agent configuration

Adapter: pi_local

Use when:
- You want Paperclip to run Pi (the AI coding agent) locally as the agent runtime
- You want provider/model routing in Pi format (--provider <name> --model <id>)
- You want Pi session resume across heartbeats via --session
- You need Pi's tool set (read, bash, edit, write, grep, find, ls; plus powershell on Windows)

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- Pi CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file appended to system prompt via --append-system-prompt
- promptTemplate (string, optional): user prompt template sent to Pi on stdin in print mode (-p)
- model (string, required): Pi model id in provider/model format (for example xai/grok-4)
- thinking (string, optional): thinking level (off, minimal, low, medium, high, xhigh)
- command (string, optional): defaults to "pi"
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): absolute wall-clock run timeout in seconds (defaults to 1800 / 30 minutes; missing, 0, or negative always resolve to that ceiling — pi_local cannot disable the wall clock)
- silenceTimeoutSec (number, optional): terminate Pi after this many seconds without stdout/stderr output (defaults to 300; set to 0 to disable)
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Pi supports multiple providers and models. Use \`pi --list-models\` to list available options.
- Paperclip requires an explicit \`model\` value for \`pi_local\` agents.
- Sessions are stored in ~/.pi/paperclips/ and resumed with --session.
- All tools (read, bash, edit, write, grep, find, ls) are enabled by default. On Windows the adapter also enables Pi's native \`powershell\` tool and appends shell-selection guidance so PowerShell syntax is not routed through Bash.
- Agent instructions are appended to Pi's system prompt via --append-system-prompt. On local targets the adapter writes that text to a temp file and passes the file path so the command line stays under the Windows cmd.exe 8191-character limit. The user task is sent on stdin with -p.
`;
