export const type = "cursor_local";
export const label = "Cursor (local)";
export const DEFAULT_CURSOR_LOCAL_MODEL = "auto";

export const models = [
  { id: "gpt-5.2", label: "gpt-5.2" },
  { id: "sonnet-4.5", label: "sonnet-4.5" },
];

export const agentConfigurationDoc = `# cursor_local agent configuration

Adapter: cursor_local

Use when:
- The agent should run the Cursor CLI locally (headless/print mode) on the host machine.
- You need session persistence across runs (Cursor supports --resume=<session_id>).
- The task benefits from Cursor's agent tools and stream-json output for progress.

Don't use when:
- Cursor CLI is not installed (e.g. \`agent\` or \`cursor agent\` not on PATH).
- You need a simple one-shot script (use the process adapter instead).
- Running in an environment without CURSOR_API_KEY or \`agent login\` (auth required for headless).

Core fields:
- cwd (string, optional): absolute working directory; process runs with this as both cwd and --workspace.
- command (string, optional): CLI command, default \`agent\`.
- model (string, optional): e.g. gpt-5.2, sonnet-4.5 (see Cursor Parameters docs).
- promptTemplate (string): prompt template for each run; rendered then passed as \`-p "<prompt>"\`.
- outputFormat (string, optional): \`stream-json\` (recommended), \`json\`, or \`text\`.
- instructionsFilePath (string, optional): path to instructions file (e.g. AGENTS.md) injected into context.
- timeoutSec (number, optional): run timeout in seconds; 0 = no timeout.
- graceSec (number, optional): SIGTERM grace period before SIGKILL.
- force (boolean, optional): allow file modifications in print mode without confirmation (headless).
- trust (boolean, optional): trust workspace without prompting (headless).
  **If trust or force are disabled, headless runs may block on a \"Workspace Trust Required\" prompt**; enable both for unattended operation (defaults: true).
- env (object, optional): environment variables (e.g. CURSOR_API_KEY via secret or plain).
- extraArgs (string[], optional): additional CLI arguments.

Output format (stream-json): NDJSON events — system (subtype init), user, assistant, tool_call, result. See Cursor CLI Output format docs and doc/research/cursor-invocation-surface.md.

Skills: When a Paperclip skills source is available, the adapter injects skills into user-level \`~/.cursor/skills/\` (or \`CURSOR_HOME/skills/\` when \`CURSOR_HOME\` is set), skipping existing entries. The process runs with cwd and \`--workspace\` equal to the user project directory. The adapter does not write into your project directory. See doc/research/cursor-invocation-surface.md.
`;
