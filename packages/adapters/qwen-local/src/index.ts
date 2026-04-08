export const type = "qwen_local";
export const label = "Qwen Code (local)";

export const models = [
  { id: "qwen3-coder-plus", label: "Qwen3 Coder Plus" },
  { id: "qwen3-coder", label: "Qwen3 Coder" },
  { id: "qwen3-coder-flash", label: "Qwen3 Coder Flash" },
  { id: "qwen-plus", label: "Qwen Plus" },
  { id: "qwen-turbo", label: "Qwen Turbo" },
];

export const agentConfigurationDoc = `# qwen_local agent configuration

Adapter: qwen_local

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a system instructions file
- model (string, optional): Qwen model id (e.g. qwen3-coder-plus, qwen3-coder, qwen3-coder-flash)
- promptTemplate (string, optional): run prompt template
- maxTurnsPerRun (number, optional): max turns for one run (--max-session-turns)
- yolo (boolean, optional, default true): pass --yolo to auto-approve all tool use; defaults to true because Paperclip runs Qwen Code in headless mode where interactive approval cannot be answered
- command (string, optional): defaults to "qwen"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables
- workspaceStrategy (object, optional): execution workspace strategy; currently supports { type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }
- workspaceRuntime (object, optional): reserved for workspace runtime metadata; workspace runtime services are manually controlled from the workspace UI and are not auto-started by heartbeats

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- When Paperclip realizes a workspace/runtime for a run, it injects PAPERCLIP_WORKSPACE_* and PAPERCLIP_RUNTIME_* env vars for agent-side tooling.
- Qwen Code uses \`--output-format stream-json\` for structured streaming output.
- Session persistence is project-scoped under \`~/.qwen/projects/<sanitized-cwd>/chats\`.
`;

export { createServerAdapter } from "./server/index.js";
