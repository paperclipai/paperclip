export const type = "t3code_local";
export const label = "T3 Code (local)";

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# t3code_local agent configuration

Adapter: t3code_local

Use when:
- You run a T3 Code server (\`t3 serve\`) on the Paperclip host and want Paperclip agents to work through T3 Code threads
- You want the agent's work visible and steerable in T3 Code's web, desktop, or mobile app
- You want T3 Code to pick the coding agent (Claude, Codex, OpenCode, ...) per project or per agent

Don't use when:
- Paperclip runs on a different machine from the T3 Code server (this adapter is local only)
- The agent needs PAPERCLIP_* environment variables: the agent runs inside T3 Code's provider process, not under Paperclip's environment
- You need token usage or cost reporting (T3 Code does not report it)

Core fields:
- cwd (string, optional): default absolute working directory fallback. The run's workspace is registered as a T3 Code project with \`t3 project add\` when no project contains it yet.
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the message on each run
- promptTemplate (string, optional): run prompt template
- provider (string, optional): T3 Code provider instance id (for example "claudeAgent" or "codex"). Requires model.
- model (string, optional): model slug for the provider instance. Requires provider. Both omitted uses the project's default model.
- command (string, optional): defaults to "t3"
- env (object, optional): KEY=VALUE environment variables for the t3 CLI process (for example T3CODE_HOME). They do not reach the agent.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds; on timeout the adapter stops the thread's running turn
- graceSec (number, optional): SIGTERM grace period in seconds, also the budget for confirming that a stopped turn ended

Notes:
- New runs use \`t3 thread start <cwd> - --wait --json\`; the message is read from stdin.
- Later runs in the same cwd with the same provider and model queue the message on the same thread with \`t3 thread send <threadId> - --wait --json\`.
- Exit code 2 means the agent asked a question that must be answered in T3 Code; the run fails with the thread id so it can be answered there.
- On timeout or cancellation the adapter runs \`t3 thread stop <threadId> --json\` and only reports the provider as stopped once T3 Code confirms the turn ended.
- Skills are managed by T3 Code's providers, not by Paperclip.
`;
