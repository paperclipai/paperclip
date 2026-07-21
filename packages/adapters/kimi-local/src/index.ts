import { buildSandboxNpmInstallCommand } from "@paperclipai/adapter-utils";

export const type = "kimi_local";
export const label = "Kimi Code CLI (local)";

export const SANDBOX_INSTALL_COMMAND = buildSandboxNpmInstallCommand("@moonshot-ai/kimi-code");

export const DEFAULT_KIMI_LOCAL_MODEL = "kimi-code/kimi-for-coding";

export const models = [
  { id: DEFAULT_KIMI_LOCAL_MODEL, label: "K2.7 Coding" },
  { id: "kimi-code/kimi-for-coding-highspeed", label: "K2.7 Coding Highspeed" },
  { id: "kimi-code/k3", label: "K3" },
];

/**
 * Kimi thinking-effort tiers. Kimi's catalog exposes these via each model's
 * `support_efforts`; note there is no "medium" tier (Kimi collapses it onto
 * "high"). Sending an effort a model does not support makes the provider
 * reject the request, so effort is only forwarded for effort-capable models.
 */
export const KIMI_SUPPORTED_EFFORTS = ["low", "high", "max"] as const;
export type KimiEffort = (typeof KIMI_SUPPORTED_EFFORTS)[number];

/**
 * Models that advertise `support_efforts` in Kimi's model catalog. Keep in
 * sync with `models` above; only these accept KIMI_MODEL_THINKING_EFFORT.
 */
export const EFFORT_CAPABLE_MODELS = new Set<string>(["kimi-code/k3"]);

export function modelSupportsEffort(model: string): boolean {
  return EFFORT_CAPABLE_MODELS.has(model.trim());
}

/**
 * Map a Paperclip effort value onto Kimi's supported thinking-effort set.
 * Returns null for values Kimi cannot honor so the caller leaves Kimi's own
 * default_effort in place instead of forwarding an invalid tier.
 */
export function resolveKimiThinkingEffort(effort: string): KimiEffort | null {
  const normalized = effort.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "medium") return "high";
  return (KIMI_SUPPORTED_EFFORTS as readonly string[]).includes(normalized)
    ? (normalized as KimiEffort)
    : null;
}

export const agentConfigurationDoc = `# kimi_local agent configuration

Adapter: kimi_local

Use when:
- You want Paperclip to run the Kimi Code CLI (kimi) locally on the host machine
- You want Kimi sessions resumed across heartbeats with -r
- You want Paperclip skills injected into the Kimi skills home without polluting the agent workspace

Don't use when:
- You need webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- Kimi Code CLI is not installed on the machine that runs Paperclip

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt. Sibling files in the same directory (HEARTBEAT.md, SOUL.md, TOOLS.md) are made readable via --add-dir for local runs.
- promptTemplate (string, optional): run prompt template
- model (string, optional): Kimi model alias (provider/model). Defaults to kimi-code/kimi-for-coding.
- effort (string, optional): thinking effort (low | medium | high | max). Forwarded as KIMI_MODEL_THINKING_EFFORT for effort-capable models (currently kimi-code/k3); "medium" maps to "high" since Kimi has no medium tier. Ignored for models without support_efforts.
- command (string, optional): defaults to "kimi"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- The adapter defaults to the ACP engine (\`kimi acp\`) and falls back to the headless CLI lane when ACP prerequisites are unavailable. Set \`engine\` to \`acp\` or \`cli\` to require a specific lane.
- CLI-lane runs use \`kimi -p\` with \`--output-format stream-json\` for non-interactive headless execution; the prompt is passed as an argument, not stdin.
- The adapter sets a headless-safe environment (CI=1, NO_COLOR=1, KIMI_CODE_NO_AUTO_UPDATE=1) so unattended runs never wait on interactive prompts or update preflight.
- Sessions resume with \`-r <session_id>\` when the stored session cwd matches the current cwd; the session id is captured from the trailing session.resume_hint meta event.
- Desired Paperclip skills are delivered to local runs via \`--skills-dir\` pointing at a per-run managed directory, so skills load reliably without polluting the user's \`~/.kimi-code/skills\` home. Remote runs sync skills into the remote skills home.
- Authentication uses \`kimi login\` (OAuth device flow), providers configured in Kimi's config.toml, or the KIMI_MODEL_NAME + KIMI_MODEL_API_KEY environment pair.
`;
