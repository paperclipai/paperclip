export const type = "kimchi_local";
export const label = "Kimchi CLI (local)";

/**
 * Kimchi is distributed as a binary tarball from GitHub releases
 * (getkimchi/kimchi), not as an npm package, so this is a plain install
 * command documenting the official install script rather than a
 * `buildSandboxNpmInstallCommand` npm invocation.
 */
export const SANDBOX_INSTALL_COMMAND =
  "curl -fsSL https://github.com/getkimchi/kimchi/releases/latest/download/install.sh | bash";

export const DEFAULT_KIMCHI_LOCAL_MODEL = "kimi-k2.7";

/**
 * Models offered through Kimchi Inference as documented by the Kimchi CLI.
 * Kimchi is multi-model capable and selects orchestrator/builder/reviewer/
 * explorer roles in-session through the ACP model selector, so these are the
 * selectable model ids only; multi-model mode needs no CLI flag from the
 * adapter.
 */
export const models = [
  { id: "kimi-k2.7", label: "Kimi K2.7" },
  { id: "kimi-k3", label: "Kimi K3" },
  { id: "minimax-m3", label: "MiniMax M3" },
  { id: "nemotron-3-ultra-fp4", label: "Nemotron 3 Ultra (FP4)" },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { id: "glm-5.3", label: "GLM 5.3" },
  { id: "glm-5.3-flash", label: "GLM 5.3 Flash" },
];

export const agentConfigurationDoc = `# kimchi_local agent configuration

Adapter: kimchi_local

Use when:
- You want Paperclip to run the Kimchi CLI (kimchi) locally on the host machine
- You want the Kimchi agent to execute tasks through the ACP protocol (kimchi --mode acp)
- You want Kimchi's multi-model orchestration (orchestrator/builder/reviewer/explorer roles) selected in-session

Don't use when:
- You need webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- The Kimchi CLI is not installed on the machine that runs Paperclip
- You need per-session MCP registration configured at runtime (Kimchi v0.0.7 requires MCP servers in its config file before start)
- You need image or audio input delivered to the agent (Kimchi v0.0.7 drops image/audio content)
- You need sessions resumed across heartbeats (Kimchi v0.0.7 has no session persistence; every run starts a fresh session)

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Kimchi Inference model id (for example kimi-k2.7, glm-5.3). Multi-model mode is selected in-session through the ACP model selector (multi-model/<orchestrator-ref>), not via CLI flag.
- command (string, optional): defaults to "kimchi"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- The adapter is ACP-only: it always launches \`kimchi --mode acp\` through the shared ACP engine and fails with a setup error (adapter_engine_unavailable) when ACP prerequisites are unavailable. There is no CLI-lane JSON streaming fallback in v1 because Kimchi's headless \`-p\` JSON-streaming mode is unverified.
- Kimchi v0.0.7 is the first ACP release; earlier binaries do not accept \`--mode acp\`.
- The adapter sets a headless-safe environment (CI=1, NO_COLOR=1) so unattended runs never wait on interactive prompts and styling never breaks parsing. Telemetry is on by default; set KIMCHI_TELEMETRY_ENABLED=0 in env to opt out.
- The first run may install Kimchi's RTK harness into ~/.config/kimchi/harness/rtk; expect first-run side effects.
- Kimchi has no skills directory contract Paperclip can manage; desired Paperclip skills are tracked but not delivered to the agent in v1. Configure Kimchi's own skills through its config under ~/.config/kimchi/.
- Authentication uses the KIMCHI_API_KEY environment variable, or a browser/subscription login completed inside the CLI (\`kimchi\` then \`/login\`, or the \`kimchi setup\` wizard).
`;
