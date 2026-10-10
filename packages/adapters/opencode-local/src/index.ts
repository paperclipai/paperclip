export const type = "opencode_local";
export const label = "OpenCode";

// Paperclip qualifies OpenCode for this adapter on the 1.x and 2.x lines: the
// CLI JSONL contract (`opencode run --format json`) and the injected runtime
// config shape are verified against both. V2 changed the `run` contract the
// adapter drives (`--variant` folds into `provider/model#variant`, `models`
// drops `--refresh`) and the server/plugin APIs, so `server/version.ts` gates
// the CLI flags by major and the sandbox installer below pins a qualified
// release instead of `latest`.
export const QUALIFIED_OPENCODE_VERSION = "1.18.34";
export const SUPPORTED_OPENCODE_MAJOR_VERSIONS = [1, 2] as const;

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
// The installer is pinned to QUALIFIED_OPENCODE_VERSION via `--version` so a
// sandbox always receives the release Paperclip qualifies rather than whatever
// `latest` resolves to.
//
// Security tradeoff: this is `curl | bash` without a SHA-256 verification of
// the install script. We accept this because:
//   1. The install runs inside an isolated, ephemeral sandbox — blast radius
//      is bounded to that sandbox's secrets and disk.
//   2. The prior `npm install -g opencode-ai` is also unverified code
//      execution from a third-party registry; this is not strictly worse.
//   3. OpenCode does not publish per-release SHA-256 checksums in a stable
//      location, so we pin the release tag (not a digest).
// The `set -e` (implied by Bash's default with `-fsSL` upstream of a piped
// shell) and `curl -fsSL` give us fail-fast behavior on HTTP errors. If
// OpenCode starts publishing a stable checksum/signature, switch to fetching
// a versioned tarball + verifying the digest before exec.
export const SANDBOX_INSTALL_COMMAND =
  `curl -fsSL https://opencode.ai/install | bash -s -- --version ${QUALIFIED_OPENCODE_VERSION} && ` +
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
  { id: "openai/gpt-6-astra", label: "openai/gpt-6-astra" },
  { id: "openai/gpt-6.1-sol", label: "openai/gpt-6.1-sol" },
  { id: "openai/gpt-6-sol", label: "openai/gpt-6-sol" },
  { id: "openai/gpt-6-luna", label: "openai/gpt-6-luna" },
  { id: "openai/gpt-5.6-sol", label: "openai/gpt-5.6-sol" },
  { id: "openai/gpt-5.6-terra", label: "openai/gpt-5.6-terra" },
  { id: "openai/gpt-5.6-luna", label: "openai/gpt-5.6-luna" },
  { id: "anthropic/claude-opus-5-5", label: "anthropic/claude-opus-5-5" },
  { id: "anthropic/claude-opus-5", label: "anthropic/claude-opus-5" },
  { id: "anthropic/claude-fable-5-1", label: "anthropic/claude-fable-5-1" },
  { id: "anthropic/claude-sonnet-5-5", label: "anthropic/claude-sonnet-5-5" },
  { id: "anthropic/claude-sonnet-5", label: "anthropic/claude-sonnet-5" },
  { id: "google/gemini-3.8-flash", label: "google/gemini-3.8-flash" },
  { id: "xai/grok-4.7", label: "xai/grok-4.7" },
  { id: "openai/gpt-5.5", label: "openai/gpt-5.5" },
  { id: "openai/gpt-5.4", label: "openai/gpt-5.4" },
  { id: "openai/gpt-5.4-mini", label: "openai/gpt-5.4-mini" },
  { id: "openai/gpt-5.2", label: "openai/gpt-5.2" },
  { id: "openai/gpt-5.1-codex-max", label: "openai/gpt-5.1-codex-max" },
  { id: "openai/gpt-5.1-codex-mini", label: "openai/gpt-5.1-codex-mini" },
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
- model (string, required): OpenCode model id in provider/model format (for example anthropic/claude-sonnet-4-5)
- variant (string, optional): provider-specific reasoning/profile variant passed as --variant (for example minimal|low|medium|high|xhigh|max)
- dangerouslySkipPermissions (boolean, optional): auto-approve headless permissions. Injects a runtime OpenCode config allowing all tools and external-directory access (V1 \`permission=allow\`, V2 native \`permissions\`) and passes \`--auto\` to \`opencode run\`; defaults to true for unattended Paperclip runs
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "opencode"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- OpenCode supports multiple providers and models. Use \
  \`opencode models\` to list available options in provider/model format.
- Paperclip requires an explicit \`model\` value for \`opencode_local\` agents.
- Paperclip supports OpenCode 1.x and 2.x. The adapter detects the installed \
  major before a run and adjusts the CLI flags accordingly (V2 folds the variant \
  into \`provider/model#variant\`); an unsupported major is rejected with an \
  actionable error. Set PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_VERSION=1 to bypass \
  that guard for an unverified run.
- Runs are executed with: opencode run --format json (plus --auto when headless permissions are enabled)...
- Sessions are resumed with --session when stored session cwd matches current cwd.
- The adapter sets OPENCODE_DISABLE_PROJECT_CONFIG=true to prevent OpenCode from \
  writing an opencode.json config file into the project working directory. Model \
  selection is passed via the --model CLI flag instead.
- When \`dangerouslySkipPermissions\` is enabled, Paperclip injects a temporary \
  runtime config that allows all tools and external-directory access (V1 \
  \`permission=allow\`; V2 native \`permissions\`), and passes \`--auto\` to \
  \`opencode run\`. Together these stop headless runs from stalling on approval \
  prompts for the agent instructions and file-sync trees, while explicit deny \
  rules and policies still apply.
`;
