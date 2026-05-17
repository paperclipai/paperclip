import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "opencode_local";
export const label = "OpenCode (local)";

// Use OpenCode's official installer instead of `npm install -g opencode-ai`.
// The npm package reifies four large Linux x64 prebuilt-binary subpackages
// (linux-x64, linux-x64-musl, linux-x64-baseline, linux-x64-baseline-musl) in
// parallel even though only one matches the sandbox; on bandwidth-constrained
// sandboxes (e.g. Cloudflare) that exceeded the 240s install budget. The
// official installer fetches a single arch-specific binary into
// `$HOME/.opencode/bin` and tries to add it to PATH via `~/.bashrc`. That
// rc-file path is only sourced by interactive/login shells, so non-login
// `sh -c` probe invocations (used by the runtime PATH check) cannot find the
// binary. We fix that by symlinking the installed binary into a directory on
// the non-login `sh -c` PATH: prefer `/usr/local/bin` (universally on the
// default PATH on Linux distros) when root or passwordless sudo is available,
// otherwise fall back to `$HOME/.local/bin` (which is on the default PATH on
// the exe.dev sandbox image and most modern home-managed Linux images).
//
// Security tradeoff: this is `curl | bash` without a SHA-256 verification of
// the install script. We accept this because:
//   1. The install runs inside an isolated, ephemeral sandbox — blast radius
//      is bounded to that sandbox's secrets and disk.
//   2. The prior `npm install -g opencode-ai` is also unverified code
//      execution from a third-party registry; this is not strictly worse.
//   3. OpenCode does not publish per-release SHA-256 checksums in a stable
//      location, and pinning a version + hash here would require manual
//      version bumps on every OpenCode release.
// The `set -e` (implied by Bash's default with `-fsSL` upstream of a piped
// shell) and `curl -fsSL` give us fail-fast behavior on HTTP errors. If
// OpenCode starts publishing a stable checksum/signature, switch to fetching
// a versioned tarball + verifying the digest before exec.
export const SANDBOX_INSTALL_COMMAND =
  'curl -fsSL https://opencode.ai/install | bash && ' +
  'if [ -x "$HOME/.opencode/bin/opencode" ]; then ' +
  'if [ "$(id -u)" -eq 0 ]; then ' +
  'ln -sf "$HOME/.opencode/bin/opencode" /usr/local/bin/opencode; ' +
  'elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then ' +
  'sudo ln -sf "$HOME/.opencode/bin/opencode" /usr/local/bin/opencode; ' +
  'else ' +
  'mkdir -p "$HOME/.local/bin" && ' +
  'ln -sf "$HOME/.opencode/bin/opencode" "$HOME/.local/bin/opencode"; ' +
  'fi; ' +
  'fi';

export const DEFAULT_OPENCODE_LOCAL_MODEL = "openai/gpt-5.2-codex";

export function isValidOpenCodeModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const slashIndex = trimmed.indexOf("/");
  return Boolean(trimmed) && slashIndex > 0 && slashIndex !== trimmed.length - 1;
}

export const models: Array<{ id: string; label: string }> = [
  { id: DEFAULT_OPENCODE_LOCAL_MODEL, label: DEFAULT_OPENCODE_LOCAL_MODEL },
  { id: "openai/gpt-5.4", label: "openai/gpt-5.4" },
  { id: "openai/gpt-5.2", label: "openai/gpt-5.2" },
  { id: "openai/gpt-5.1-codex-max", label: "openai/gpt-5.1-codex-max" },
  { id: "openai/gpt-5.1-codex-mini", label: "openai/gpt-5.1-codex-mini" },
  // OpenRouter — set env.OPENROUTER_API_KEY and env.OPENAI_BASE_URL=https://openrouter.ai/api/v1
  { id: "openrouter/anthropic/claude-opus-4", label: "openrouter/anthropic/claude-opus-4" },
  { id: "openrouter/anthropic/claude-sonnet-4.5", label: "openrouter/anthropic/claude-sonnet-4.5" },
  { id: "openrouter/anthropic/claude-haiku-4.5", label: "openrouter/anthropic/claude-haiku-4.5" },
  { id: "openrouter/google/gemini-3-pro-preview", label: "openrouter/google/gemini-3-pro-preview" },
  { id: "openrouter/openai/gpt-5", label: "openrouter/openai/gpt-5" },
  { id: "openrouter/openai/gpt-5.2-codex", label: "openrouter/openai/gpt-5.2-codex" },
  { id: "openrouter/deepseek/deepseek-chat", label: "openrouter/deepseek/deepseek-chat" },
  { id: "openrouter/mistralai/mistral-small-3.1-24b-instruct", label: "openrouter/mistralai/mistral-small-3.1-24b-instruct" },
  { id: "openrouter/owl-alpha", label: "openrouter/owl-alpha" },
  { id: "openrouter/stepfun/step-3.5-flash", label: "openrouter/stepfun/step-3.5-flash" },
  { id: "openrouter/deepseek/deepseek-v4-flash:free", label: "openrouter/deepseek/deepseek-v4-flash:free" },
  { id: "openrouter/qwen/qwen3-coder:free", label: "openrouter/qwen/qwen3-coder:free" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use OpenCode's known Codex mini model as the budget lane.",
    adapterConfig: {
      model: "openai/gpt-5.1-codex-mini",
      variant: "low",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# opencode_local agent configuration

Adapter: opencode_local

Use when:
- You want Paperclip to run OpenCode locally as the agent runtime
- You want provider/model routing in OpenCode format (provider/model)
- You want OpenCode session resume across heartbeats via --session

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- OpenCode CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- model (string, required): OpenCode model id in provider/model format (for example openrouter/anthropic/claude-sonnet-4-5 or anthropic/claude-sonnet-4-5)
- variant (string, optional): provider-specific reasoning/profile variant passed as --variant (for example minimal|low|medium|high|xhigh|max)
- dangerouslySkipPermissions (boolean, optional): inject a runtime OpenCode config that allows \`external_directory\` access without interactive prompts; defaults to true for unattended Paperclip runs
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "opencode"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

## OpenRouter models

OpenCode routes through OpenRouter when two environment variables are set. Add them
via the "Environment variables" panel in the agent config form:

\`\`\`json
{
  "env": {
    "OPENROUTER_API_KEY": { "type": "secret_ref", "secretId": "<your-secret-id>" },
    "OPENAI_BASE_URL": { "type": "plain", "value": "https://openrouter.ai/api/v1" }
  }
}
\`\`\`

- \`OPENROUTER_API_KEY\` — your OpenRouter API key. Prefer storing this as a
  \`secret_ref\` bound to a company secret so the plaintext value is not written
  into the agent config JSONB.
- \`OPENAI_BASE_URL\` — set to \`https://openrouter.ai/api/v1\` so OpenCode routes
  OpenAI-format requests through OpenRouter. \`OPENAI_API_BASE\` and
  \`OPENAI_API_BASE_URL\` are accepted as fallbacks if the primary key is absent.

After setting those variables, pick any \`openrouter/\`-prefixed model from the
model drop-down (for example \`openrouter/anthropic/claude-sonnet-4.5\`).
Paperclip will automatically tag the run with \`biller: "openrouter"\` for cost
tracking — no other configuration change is needed.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- OpenCode supports multiple providers and models. Use \
  \`opencode models\` to list available options in provider/model format.
- Paperclip requires an explicit \`model\` value for \`opencode_local\` agents.
- Runs are executed with: opencode run --format json ...
- Sessions are resumed with --session when stored session cwd matches current cwd.
- The adapter sets OPENCODE_DISABLE_PROJECT_CONFIG=true to prevent OpenCode from \
  writing an opencode.json config file into the project working directory. Model \
  selection is passed via the --model CLI flag instead.
- When \`dangerouslySkipPermissions\` is enabled, Paperclip injects a temporary \
  runtime config with \`permission.external_directory=allow\` so headless runs do \
  not stall on approval prompts.
`;
