export const type = "pi_local";
export const label = "Pi";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @earendil-works/pi-coding-agent@0.74.0";

export const models: Array<{ id: string; label: string }> = [];

/**
 * Instance-level default model for `pi_local` hires.
 *
 * Pi routes each company through its own gateway/provider, so there is no safe
 * universal default model id to ship the way the other local adapters do. An
 * operator who has already configured Pi on the host can still name the model
 * this install should fall back to, through either of:
 *
 * - `PAPERCLIP_PI_LOCAL_DEFAULT_MODEL=provider/model`
 * - `PI_PROVIDER=provider` plus `PI_MODEL=model` (the Pi CLI's own variables)
 *
 * When neither is set, `pi_local` hires keep requiring an explicit `model`.
 */
export const PI_LOCAL_DEFAULT_MODEL_ENV_KEY = "PAPERCLIP_PI_LOCAL_DEFAULT_MODEL";

export function resolveDefaultPiLocalModel(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const explicit = env[PI_LOCAL_DEFAULT_MODEL_ENV_KEY]?.trim();
  if (explicit) return explicit;
  const provider = env.PI_PROVIDER?.trim();
  const model = env.PI_MODEL?.trim();
  if (provider && model) return `${provider}/${model}`;
  return null;
}

/**
 * Shape check for a Pi model id: a non-empty `provider/model` string whose
 * slash is neither the first nor the last character.
 */
export function isValidPiModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const slashIndex = trimmed.indexOf("/");
  return Boolean(trimmed) && slashIndex > 0 && slashIndex !== trimmed.length - 1;
}

export const agentConfigurationDoc = `# pi_local agent configuration

Adapter: pi_local

Use when:
- You want Paperclip to run Pi (the AI coding agent) locally as the agent runtime
- You want provider/model routing in Pi format (--provider <name> --model <id>)
- You want Pi session resume across heartbeats via --session
- You need Pi's tool set (read, bash, edit, write, grep, find, ls)

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- Pi CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file appended to system prompt via --append-system-prompt
- promptTemplate (string, optional): user prompt template passed via -p flag
- model (string, required): Pi model id in provider/model format (for example xai/grok-4)
- thinking (string, optional): thinking level (off, minimal, low, medium, high, xhigh)
- command (string, optional): defaults to "pi"
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Pi supports multiple providers and models. Use \`pi --list-models\` to list available options.
- \`model\` is required for \`pi_local\` agents. Paperclip rejects a hire with a missing or
  malformed \`provider/model\` value at creation time, instead of failing on the first run.
- Set \`PAPERCLIP_PI_LOCAL_DEFAULT_MODEL\` (or \`PI_PROVIDER\` plus \`PI_MODEL\`) on the
  Paperclip host to give this install a fallback model for hires that omit \`model\`.
- Sessions are stored in ~/.pi/paperclips/ and resumed with --session.
- All tools (read, bash, edit, write, grep, find, ls) are enabled by default.
- Agent instructions are appended to Pi's system prompt via --append-system-prompt, while the user task is sent via -p.
`;
