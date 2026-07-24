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
- You need Pi's tool set (read, bash, edit, write, grep, find, ls)

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- Pi CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file appended to system prompt via --append-system-prompt
- promptTemplate (string, optional): user prompt template passed via -p flag
- model (string, required): Pi model id in provider/model format (for example xai/grok-4)
- thinking (string, optional): thinking level (off, minimal, low, medium, high, xhigh)
- command (string, optional): defaults to "pi"
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
- stdoutLogMode (string, optional, default "compact"): controls how Pi --mode json stdout is
  compacted before entering the Paperclip run log. Pi emits cumulative state
  in every message_update event, which makes run logs grow ~quadratically.
  Modes:
  - "raw": legacy passthrough, no filtering (full transcript; large logs).
  - "compact" (default): strips cumulative copies (message_update.message,
    assistantMessageEvent.partial), converts tool_execution_update to a
    throttled content-free Paperclip progress event. Streaming deltas are
    preserved — parsePiJsonl output and live UI typing are unchanged.
  In compact mode, if a run is terminated before tool_execution_end, its
  partial tool output is not retained; use "raw" when full forensic output is required.
  Oversized individual lines are handled by the server's run-log pipeline
  (redaction + head/tail cap) regardless of mode. Invalid explicit mode values
  fail safe to "raw" rather than enabling a lossy transformation.

Notes:
- Pi supports multiple providers and models. Use \`pi --list-models\` to list available options.
- Paperclip requires an explicit \`model\` value for \`pi_local\` agents.
- Sessions are stored in ~/.pi/paperclips/ and resumed with --session.
- All tools (read, bash, edit, write, grep, find, ls) are enabled by default.
- Agent instructions are appended to Pi's system prompt via --append-system-prompt, while the user task is sent via -p.
`;
