import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export { DEFAULT_CURSOR_LOCAL_MODEL, SANDBOX_INSTALL_COMMAND } from "./adapter-constants.js";
export { models } from "./model-catalog.js";

export const type = "cursor";
export const label = "Cursor CLI (local)";

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use Cursor's known Codex mini model as the budget lane instead of assuming auto is cheap.",
    adapterConfig: {
      model: "gpt-5.1-codex-mini",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# cursor agent configuration

Adapter: cursor

Use when:
- You want Paperclip to run Cursor Agent CLI locally as the agent runtime
- You want Cursor chat session resume across heartbeats via --resume
- You want structured stream output in run logs via --output-format stream-json

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- Cursor Agent CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Cursor model id (for example auto or gpt-5.3-codex)
- mode (string, optional): Cursor execution mode passed as --mode (plan|ask). Leave unset for normal autonomous runs.
- command (string, optional): defaults to "agent"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
- maxTurnsPerRun (number, optional): max tool_call turns before the adapter kills the Cursor process. 0 (default) disables the fuse.

Notes:
- Runs are executed with: agent -p --output-format stream-json ...
- Prompts are piped to Cursor via stdin.
- Sessions are resumed with --resume when stored session cwd matches current cwd.
- Paperclip auto-injects local skills into "~/.cursor/skills" when missing, so Cursor can discover "$paperclip" and related skills on local runs.
- Paperclip auto-adds --yolo unless one of --trust/--yolo/-f is already present in extraArgs.
- Local runs prepend standard Cursor CLI install directories to the agent process PATH when \`command\` is the default (\`agent\` / \`cursor-agent\`): on Windows \`%LOCALAPPDATA%\\cursor-agent\`, plus \`~/.local/bin\` and \`~/.cursor/bin\` on all platforms, so the server can resolve the CLI even when started from a minimal environment.
- Remote sandbox runs prepend "~/.cursor/bin" and "~/.local/bin" to PATH and prefer the installed absolute entrypoint from one of those directories when the default Cursor command is requested, so installer-managed sandbox leases do not need hardcoded command paths.
`;
