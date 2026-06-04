/**
 * @paperclipai/adapter-amplifier-local — shared metadata.
 *
 * This file is imported by all three consumers (server, UI, CLI). Keep it
 * dependency-free (no Node APIs, no React) so the UI bundle stays browser-safe.
 */

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const type = "amplifier_local";
export const label = "Amplifier (local)";

/**
 * Canonical install command surfaced in `agentConfigurationDoc` and used by
 * the platform's sandbox install path. amplifier-agent v0.4+ declares `mcp`
 * as a transitive dependency, so the previous `--with mcp` workaround is no
 * longer required.
 */
export const SANDBOX_INSTALL_COMMAND =
  "uv tool install git+https://github.com/microsoft/amplifier-agent";

/**
 * Default model used when none is explicitly configured. Matches the
 * provider-anthropic module's default in amplifier-agent's bundle.md.
 */
export const DEFAULT_AMPLIFIER_LOCAL_MODEL = "claude-opus-4-5";

/**
 * The four provider modules amplifier-agent ships in its default bundle.
 * The adapter derives the provider from the model id (see deriveProvider
 * in src/server/amplifier-args.ts); the user never picks a provider in the
 * UI, only a model.
 */
export const AMPLIFIER_LOCAL_PROVIDERS = [
  "anthropic",
  "openai",
  "azure-openai",
  "ollama",
] as const;
export type AmplifierLocalProvider = (typeof AMPLIFIER_LOCAL_PROVIDERS)[number];

/**
 * Models advertised to the agent creation form. Provider is derived from the
 * model id by the adapter (claude-* to anthropic, gpt-* / o3-* / o4-* to
 * openai, llama* to ollama). amplifier-agent v0.4+'s host_config layer
 * accepts model overrides via provider.config.model, so any string here
 * gets honored.
 */
export const models = [
  // Anthropic
  { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet (2024-10-22)" },
  // OpenAI
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5", label: "GPT-5" },
  { id: "gpt-5-mini", label: "GPT-5 mini" },
  { id: "o3", label: "o3" },
  { id: "o3-mini", label: "o3-mini" },
  { id: "o4-mini", label: "o4-mini" },
  // Ollama (local)
  { id: "llama3.2", label: "Llama 3.2 (Ollama)" },
];

// ---------------------------------------------------------------------------
// agentConfigurationDoc — routing logic for LLM-driven agent configuration
// ---------------------------------------------------------------------------

export const agentConfigurationDoc = `# amplifier_local agent configuration

Adapter: amplifier_local

Use when:
- The agent should run the Amplifier engine (amplifier-agent Python CLI) locally on the host machine
- You want the agent to use the four-specialist orchestration pattern (parent agent + explorer/planner/coder/tester sub-agents) for multi-step work
- You need MCP tool integration via the engine's tool-mcp module
- You need session continuity across heartbeats (amplifier-agent supports session resumption via --resume)

Don't use when:
- The agent only needs a simple one-shot LLM call (use the "process" adapter or a thinner adapter instead)
- amplifier-agent is not installed on the host (run \`uv tool install git+https://github.com/microsoft/amplifier-agent\` first)
- You need fine-grained per-tool approval prompts during agent execution (this adapter always passes --yes to satisfy amplifier-agent's G3 fail-fast on headless runs; configure host_config.approval.mode explicitly if you need different policy)

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible). Paperclip workspaces override this when an active workspace is present.
- model (string, optional): amplifier-agent model id. Provider is derived from the prefix (claude-* → anthropic, gpt-*/o3-*/o4-* → openai, llama* → ollama). Defaults to "${DEFAULT_AMPLIFIER_LOCAL_MODEL}".
- promptTemplate (string, optional): heartbeat prompt template (uses {{variable}} substitution). Defaults to the shared DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE.
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the prompt at runtime.
- command (string, optional): defaults to "amplifier-agent" (resolved via PATH).
- extraArgs (string[], optional): additional CLI args appended verbatim to the amplifier-agent invocation.
- env (object, optional): KEY=VALUE environment variables. Use this to inject provider API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, AZURE_OPENAI_API_KEY, OLLAMA_HOST) and any AMPLIFIER_* overrides.
- workspaceStrategy (object, optional): execution workspace strategy; currently supports { type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }
- workspaceRuntime (object, optional): reserved for workspace runtime metadata; runtime services are manually controlled from the workspace UI and are not auto-started by heartbeats

Operational fields:
- timeoutSec (number, optional): run timeout in seconds. 0 = no timeout (platform default applies).
- graceSec (number, optional): SIGTERM grace period in seconds. Default 15.

Notes:
- amplifier-agent emits a single JSON envelope on stdout at end-of-turn (the §4.1 wire envelope) and structured wire-protocol events on stderr (result/delta, tool/started, tool/completed, usage, error, etc.). The adapter parses both.
- The adapter always passes \`-y\` (auto-approve all tool calls) to satisfy amplifier-agent's G3 fail-fast rule for non-TTY invocations. To deny tool calls explicitly, set host_config.approval.mode = "no" via env config.
- The adapter writes a per-turn host_config.json containing provider selection, approval mode, MCP config path, and skill source dirs. It is passed to amplifier-agent via \`--config <path>\`.
- MCP server config (when configured) is spilled to a 0600 tmpfile and forwarded to amplifier-agent via AMPLIFIER_MCP_CONFIG environment variable (the engine's tool-mcp module reads it natively).
- Paperclip skills are injected into a per-instance managed directory (under ~/.paperclip/instances/<id>/companies/<companyId>/amplifier-skills/) and made discoverable to amplifier-agent's tool-skills module via host_config.skills.skills.
- amplifier-agent stores per-session state at $XDG_STATE_HOME/amplifier-agent/sessions/<id>/. Sessions resume via --resume; the adapter gates resume on cwd match (sessions saved in a different cwd are not resumed).
- The adapter pins --protocol-version 0.2.0. Engine protocol bumps require coordinated wrapper + adapter updates.
- When Paperclip realizes a workspace/runtime for a run, it injects PAPERCLIP_WORKSPACE_* and PAPERCLIP_RUNTIME_* env vars for agent-side tooling.
- Provider API keys must be configured via the \`env\` field (e.g. {"env": {"ANTHROPIC_API_KEY": "sk-..."}}); the adapter does not read keys from the host environment.
`;
