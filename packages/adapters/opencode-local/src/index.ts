export const type = "opencode_local";
export const label = "OpenCode";

// Install a pinned OpenCode release binary instead of `npm install -g
// opencode-ai`. The npm package reifies four large Linux x64 prebuilt-binary
// subpackages (linux-x64, linux-x64-musl, linux-x64-baseline,
// linux-x64-baseline-musl) in parallel even though only one matches the
// sandbox; on bandwidth-constrained sandboxes (e.g. Cloudflare) that exceeded
// the 240s install budget. Fetching the single matching release tarball keeps
// the install small.
//
// The tarball is downloaded from the pinned GitHub release and its SHA-256 is
// checked against the digest pinned below before anything is extracted or run.
// Piping `https://opencode.ai/install` into a shell ran unverified code: anyone
// who could serve that URL (a compromised host, or a network attacker holding a
// mis-issued TLS certificate) got code execution inside the sandbox with its
// provider credentials. Target selection mirrors OpenCode's own installer
// (x64 without AVX2 needs the `-baseline` build; musl libc needs `-musl`).
//
// To bump: set OPENCODE_SANDBOX_VERSION and copy each linux tarball's
// `digest` from `gh api repos/anomalyco/opencode/releases/tags/v<version>`.
export const OPENCODE_SANDBOX_VERSION = "1.19.3";

export const OPENCODE_SANDBOX_SHA256: Readonly<Record<string, string>> = {
  "linux-x64": "13a8fb2978302071b86f9d7e00da9c8895f9cd846978379c3bdc6a5333536c9b",
  "linux-x64-musl": "6c84c607077057cf5c8c63704e373d0053684bf29b397979f661d7fe68925487",
  "linux-x64-baseline": "531cff2441129c30f0edd5878af494108ad07f5feb46d7ee29a2a5b830a5765d",
  "linux-x64-baseline-musl": "738506562666cc67e3512f04ecac50c0bae833c5bf44e1a59c99e5827a851778",
  "linux-arm64": "7900818a6a98881edbbadab4b7525940eff3b9750040c200481f9f56cacee405",
  "linux-arm64-musl": "39c9ff1ea47fd59752613079f97bef40a2d14c30bc6bb5772a91d9d708e2d0b3",
};

const OPENCODE_RELEASE_BASE_URL = "https://github.com/anomalyco/opencode/releases/download";

export function buildOpenCodeSandboxInstallCommand(
  version: string = OPENCODE_SANDBOX_VERSION,
  sha256ByTarget: Readonly<Record<string, string>> = OPENCODE_SANDBOX_SHA256,
): string {
  const hashCases = Object.entries(sha256ByTarget)
    .map(([target, sha]) => `${target}) OC_SHA=${sha} ;; `)
    .join("");
  return [
    'OC_ARCH="$(uname -m)"; ',
    'case "$OC_ARCH" in x86_64|amd64) OC_ARCH=x64 ;; aarch64|arm64) OC_ARCH=arm64 ;; ',
    '*) echo "opencode install: unsupported architecture $OC_ARCH" >&2; exit 1 ;; esac; ',
    'OC_TARGET="linux-$OC_ARCH"; ',
    'if [ "$OC_ARCH" = x64 ] && ! grep -qwi avx2 /proc/cpuinfo 2>/dev/null; then OC_TARGET="$OC_TARGET-baseline"; fi; ',
    'if [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; then OC_TARGET="$OC_TARGET-musl"; fi; ',
    'OC_SHA=; ',
    `case "$OC_TARGET" in ${hashCases}esac; `,
    'if [ -z "$OC_SHA" ]; then echo "opencode install: no pinned checksum for $OC_TARGET" >&2; exit 1; fi; ',
    'OC_TMP="$(mktemp -d)"; ',
    `curl -fsSL --retry 3 -o "$OC_TMP/opencode.tar.gz" "${OPENCODE_RELEASE_BASE_URL}/v${version}/opencode-$OC_TARGET.tar.gz" || { rm -rf "$OC_TMP"; exit 1; }; `,
    'if command -v sha256sum >/dev/null 2>&1; then OC_GOT="$(sha256sum "$OC_TMP/opencode.tar.gz" | cut -d" " -f1)"; ',
    'else OC_GOT="$(shasum -a 256 "$OC_TMP/opencode.tar.gz" | cut -d" " -f1)"; fi; ',
    'if [ "$OC_GOT" != "$OC_SHA" ]; then echo "opencode install: checksum mismatch for $OC_TARGET (expected $OC_SHA, got $OC_GOT)" >&2; rm -rf "$OC_TMP"; exit 1; fi; ',
    'tar -xzf "$OC_TMP/opencode.tar.gz" -C "$OC_TMP" opencode && ',
    'mkdir -p "$HOME/.opencode/bin" && ',
    'cp "$OC_TMP/opencode" "$HOME/.opencode/bin/opencode" && ',
    'chmod 0755 "$HOME/.opencode/bin/opencode" && ',
    'rm -rf "$OC_TMP" && ',
  ].join("");
}

// The binary lands in `$HOME/.opencode/bin`, which non-login `sh -c` probe
// invocations (used by the runtime PATH check) do not search. Symlink it into a
// directory on that PATH: prefer `/usr/local/bin` (universally on the default
// PATH on Linux distros) when root or passwordless sudo is available, otherwise
// fall back to `$HOME/.local/bin` (on the default PATH on the exe.dev sandbox
// image and most modern home-managed Linux images).
export const SANDBOX_INSTALL_COMMAND =
  buildOpenCodeSandboxInstallCommand() +
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
  { id: "anthropic/claude-haiku-5-5", label: "anthropic/claude-haiku-5-5" },
  { id: "google/gemini-4-argon", label: "google/gemini-4-argon" },
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
- dangerouslySkipPermissions (boolean, optional): inject a runtime OpenCode config with \`permission=allow\` for all tools and connections; defaults to true for unattended Paperclip runs
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
- Runs are executed with: opencode run --format json ...
- Sessions are resumed with --session when stored session cwd matches current cwd.
- The adapter sets OPENCODE_DISABLE_PROJECT_CONFIG=true to prevent OpenCode from \
  writing an opencode.json config file into the project working directory. Model \
  selection is passed via the --model CLI flag instead.
- When \`dangerouslySkipPermissions\` is enabled, Paperclip injects a temporary \
  runtime config with \`permission=allow\` so headless runs do \
  not stall on approval prompts.
`;
