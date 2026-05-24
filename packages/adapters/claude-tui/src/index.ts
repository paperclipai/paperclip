export const type = "claude_tui";
export const label = "Claude Code (TUI driver)";

export const models = [
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-6", label: "Claude Haiku 4.6" },
];

export const agentConfigurationDoc = `# claude_tui agent configuration

Adapter: claude_tui (experimental)

Drives the interactive Claude Code TUI through a Python wrapper instead of the
\`--print\` headless CLI. This preserves richer per-session state (modal history,
plan mode, slash-command settings) at the cost of usage telemetry resolution —
the TUI reports a single \`usage_pct\` rather than token counts.

Core fields:
- cwd (string, optional): default absolute working directory for the agent.
- instructionsFilePath (string, optional): absolute path to an AGENTS.md-style
  instructions file (passed through env for the Python driver to inject).
- model (string, optional): Claude model id to request from the TUI.
- env (object, optional): KEY=VALUE environment variables (secrets supported via
  envBindings as in claude_local).

Operational fields:
- timeoutSec (number, optional): per-turn timeout for the TUI process.
- graceSec (number, optional): SIGTERM grace period before SIGKILL.

Implementation notes:
- The adapter spawns the Python TUI driver detached (its own process group) so
  Paperclip can kill the group on cancel.
- A per-run CLAUDE_CONFIG_DIR seed directory is materialized for every run so
  concurrent agents do not corrupt each other's session state.
`;
