// ACPX runs inside the long-lived Paperclip server process. A local child needs
// a small amount of host context (PATH, locale, certificate/proxy settings, and
// provider authentication), but it must not inherit the server's complete
// environment. A runner-backed remote sandbox inherits no ambient host context
// at all. In particular, native-runner bootstrap and MCP credentials are host
// authority, not provider credentials.
const ACPX_INHERITED_HOST_ENV_KEYS = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
]);

const ACPX_INHERITED_PROVIDER_ENV_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  codex: new Set([
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
  ]),
  claude: new Set([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_USE_BEDROCK",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_PROFILE",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
  ]),
  pi: new Set(["OPENROUTER_API_KEY"]),
  gemini: new Set([
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_GENAI_USE_GCA",
  ]),
  kimi: new Set([
    "KIMI_API_KEY",
    "MOONSHOT_API_KEY",
    "KIMI_MODEL_NAME",
    "KIMI_MODEL_API_KEY",
    "KIMI_MODEL_BASE_URL",
    "KIMI_MODEL_PROVIDER_TYPE",
    "KIMI_CODE_HOME",
  ]),
  grok: new Set(["XAI_API_KEY"]),
};

/**
 * Project the server environment onto the closed set a host ACPX provider may
 * inherit. A runner-backed remote sandbox passes `false` and projects nothing.
 * Explicit adapter/runtime env is merged later and is intentionally not
 * restricted by this host projection.
 */
export function projectAcpxInheritedHostEnvironment(
  inheritedEnv: NodeJS.ProcessEnv,
  acpxAgent: string,
  inheritHostEnvironment: boolean,
): Record<string, string> {
  // A runner-backed remote sandbox crosses a serialization boundary. Ambient
  // server state is never part of that contract: provider auth/config must be
  // supplied through adapter config, resolved runtime env, or a contribution.
  if (!inheritHostEnvironment) return {};

  const providerKeys = ACPX_INHERITED_PROVIDER_ENV_KEYS[acpxAgent];
  const projected: Record<string, string> = {};
  for (const [key, value] of Object.entries(inheritedEnv)) {
    if (typeof value !== "string") continue;
    const normalizedKey = key.toUpperCase();
    const allowed =
      ACPX_INHERITED_HOST_ENV_KEYS.has(normalizedKey) ||
      /^LC_[A-Z0-9_]{1,32}$/.test(normalizedKey) ||
      providerKeys?.has(normalizedKey) === true;
    if (allowed) projected[key] = value;
  }
  return projected;
}
