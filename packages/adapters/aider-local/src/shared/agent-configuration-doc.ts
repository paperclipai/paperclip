export const agentConfigurationDoc = `# aider_local agent configuration

Adapter: aider_local

Use when:
- You want Paperclip to drive the Aider CLI locally on the host machine
- You want an edit-focused coding agent that applies diffs directly in the execution workspace
- You want chat continuity across heartbeats via Aider's chat history file

Don't use when:
- You need a webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- Aider is not installed, or no model credentials are configured on the machine that runs Paperclip

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file, passed to Aider as a read-only context file via \`--read\`
- promptTemplate (string, optional): run prompt template
- model (string, optional): Aider model alias or full litellm model id. Defaults to aider-default, which lets Aider pick from its own config/env
- command (string, optional): defaults to "aider"
- files (string[], optional): repo-relative or absolute files added to the edit set via \`--file\`
- mapTokens (number, optional): repo-map budget passed via \`--map-tokens\`
- autoCommits (boolean, optional): defaults to false, which passes \`--no-auto-commits\` so Paperclip's workspace sync decides what gets committed
- alwaysApprove (boolean, optional): defaults to true, which passes \`--yes-always\` for unattended runs
- stream (boolean, optional): defaults to true. Set false to pass \`--no-stream\`
- pretty (boolean, optional): defaults to false, which passes \`--no-pretty\` so the transcript parses cleanly
- chatHistoryFile (string, optional): chat transcript path used for resume. Defaults to \`.aider.chat.history.md\` in the run cwd
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables (for example OPENAI_API_KEY or ANTHROPIC_API_KEY)

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use \`aider --message <prompt>\` in one-shot mode; Aider exits when the turn finishes.
- Sessions resume with \`--restore-chat-history\` when the saved chat history file still matches the current cwd.
- Aider has no skills concept. Desired Paperclip skills are attached as read-only context files (\`--read <skill>/SKILL.md\`) rather than copied into the workspace.
- Usage and cost come from Aider's \`Tokens:\` / \`Cost:\` footer, so they are absent when Aider does not print it.
- Older Aider builds spell the unattended flag \`--yes\`. Set alwaysApprove=false and add \`--yes\` to extraArgs on those versions.
- The environment test runs \`aider --version\` only. It never issues a model call, because a probe turn would spend tokens and could edit files.
`;
