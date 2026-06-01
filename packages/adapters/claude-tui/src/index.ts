export const type = "claude_tui";
export const label = "Claude Code (TUI driver)";

// claude-p is a drop-in `claude -p` replacement that drives the interactive
// Claude Code TUI inside a zmux PTY. It is distributed on npm and ships a
// prebuilt binary; it drives the real `claude` binary, which must also be
// installed in the environment.
export const SANDBOX_INSTALL_COMMAND = "npm install -g claude-p";

// Mirrors claude_local — claude-p forwards `--model` through to the same
// underlying `claude` binary, so the supported model ids are identical.
export const models = [
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-opus-4-5-20251101", label: "Claude Opus 4.5" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-6", label: "Claude Haiku 4.6" },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

export const agentConfigurationDoc = `# claude_tui agent configuration

Adapter: claude_tui (experimental)

Drives the interactive Claude Code TUI through the \`claude-p\` binary (a drop-in
\`claude -p\` replacement that runs the real \`claude\` UI inside a zmux PTY)
instead of the headless \`--print\` CLI directly. The output is byte-for-byte
\`claude -p\` stream-json, so Paperclip parses it with the same pipeline as
claude_local — but the run survives environments where headless \`--print\` is
unavailable or misbehaves.

Core fields:
- cwd (string, optional): default absolute working directory for the agent.
- instructionsFilePath (string, optional): absolute path to an AGENTS.md-style
  instructions file (injected via --append-system-prompt-file, forwarded to claude).
- model (string, optional): Claude model id to request.
- effort (string, optional): reasoning effort forwarded to claude via --effort.
- chrome (boolean, optional): forward --chrome to claude.
- env (object, optional): KEY=VALUE environment variables (secrets supported via
  envBindings as in claude_local; e.g. ANTHROPIC_BASE_URL for DeepSeek/MiMo).
- maxTurnsPerRun (number, optional): max turns for one run.
- dangerouslySkipPermissions (boolean, optional, default true): pass
  --dangerously-skip-permissions; defaults true because the driver is non-interactive.
- command (string, optional): defaults to "claude-p".
- extraArgs (string[], optional): additional CLI args (forwarded verbatim to claude).

Operational fields:
- timeoutSec (number, optional): per-run timeout; also passed to claude-p via
  --timeout so the wrapper does not self-terminate at its 300s default.
- graceSec (number, optional): SIGTERM grace period before SIGKILL.

Implementation notes:
- This is a local-execution adapter. Unlike claude_local it does not (yet)
  support remote/sandbox execution targets, the Paperclip bridge, prompt-bundle
  caching, or skills materialization.
`;
