/** Names minted by the controller from the resolved task configuration.
 * Values remain in the process environment, never in argv or this manifest.
 * Do not mint this projection from ambient process.env.
 */
export const CONFIGURED_ENVIRONMENT_KEYS = "PAPERCLIP_CONFIGURED_ENV_KEYS";

export const GENERATED_RUNTIME_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  CONFIGURED_ENVIRONMENT_KEYS,
  "PAPERCLIP_AGENT_ID", "PAPERCLIP_AGENT_KEY_ID", "PAPERCLIP_AGENT_PUBLIC_KEY", "PAPERCLIP_AGENT_PRIVATE_KEY",
  "PAPERCLIP_API_KEY", "PAPERCLIP_API_URL", "PAPERCLIP_API_BRIDGE_MODE", "PAPERCLIP_COMPANY_ID", "PAPERCLIP_INSTANCE_ID",
  "PAPERCLIP_RUN_ID", "PAPERCLIP_NORMALIZED_SESSION_ID", "PAPERCLIP_RUNNER_INSTANCE_ID", "PAPERCLIP_RUNNER_BOOTSTRAP_TICKET", "PAPERCLIP_TASK_ID", "PAPERCLIP_APPROVAL_ID", "PAPERCLIP_APPROVAL_STATUS", "PAPERCLIP_LINKED_ISSUE_IDS",
  "PAPERCLIP_WAKE_REASON", "PAPERCLIP_WAKE_COMMENT_ID", "PAPERCLIP_WAKE_PAYLOAD_JSON", "PAPERCLIP_EXECUTION_MODE",
  "PAPERCLIP_WORKSPACES_JSON", "PAPERCLIP_WORKSPACE_ID", "PAPERCLIP_WORKSPACE_CWD", "PAPERCLIP_WORKSPACE_SOURCE",
  "PAPERCLIP_WORKSPACE_REPO_URL", "PAPERCLIP_WORKSPACE_REPO_REF", "PAPERCLIP_WORKSPACE_BRANCH",
  "PAPERCLIP_WORKSPACE_WORKTREE_PATH", "PAPERCLIP_WORKSPACE_REALIZATION_MODE", "PAPERCLIP_WORKSPACE_AUTHORITATIVE_ROOT",
  "PAPERCLIP_RUNTIME_PRIMARY_URL", "PAPERCLIP_RUNTIME_SERVICES_JSON", "PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON",
  "PAPERCLIP_AGENT_MESSAGE_KEY", "PAPERCLIP_HARNESS_CHECKOUT_KEY", "PAPERCLIP_EXTERNAL_CHAT_EXECUTION_BOUND_KEY",
  "PAPERCLIP_NATIVE_MCP_NAME", "PAPERCLIP_NATIVE_MCP_URL", "PAPERCLIP_NATIVE_MCP_TOKEN", "PAPERCLIP_AI_PROVIDER_KEY",
  "PAPERCLIP_PROVIDER_TRACE_PATH", "PAPERCLIP_PROVIDER_TRACE_MAX_BYTES", "PAPERCLIP_ACPX_CREDENTIAL_BINDING",
  "PAPERCLIP_RUNNER_NETWORK_ACCESS", "PAPERCLIP_RUNNER_NETWORK_ROOTS", "PAPERCLIP_RUNNER_EXTERNAL_SANDBOX",
  "PAPERCLIP_GITHUB_AUTH_MODE", "PAPERCLIP_GITHUB_HOST_HOME", "PAPERCLIP_GIT_METADATA_ROOTS",
  "PAPERCLIP_GITHUB_BROKER_TOKEN", "PAPERCLIP_GITHUB_BROKER_URL", "PAPERCLIP_GITHUB_BRIDGE_TOKEN", "PAPERCLIP_GITHUB_LAUNCHER_DIR",
]);

const RESERVED_KEYS = new Set([
  "PATH", "HOME", "USERPROFILE", "CODEX_HOME", "AGENT_HOME", "SHELL", "NODE_OPTIONS", "NODE_PATH",
  "PYTHONPATH", "PYTHONHOME", "RUBYOPT", "RUBYLIB", "PERL5OPT", "PERL5LIB", "BASH_ENV", "ENV",
  "OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK", "OPENROUTER_API_KEY", "XAI_API_KEY", "CURSOR_API_KEY", "CURSOR_AUTH_TOKEN",
  "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "PAPERCLIP_GIT_TOKEN",
]);

function eligibleKey(key: string): boolean {
  const upper = key.toUpperCase();
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)
    && !GENERATED_RUNTIME_ENVIRONMENT_KEYS.has(upper)
    && !RESERVED_KEYS.has(upper)
    && !/^(?:LD_|DYLD_|GIT_CONFIG_|PAPERCLIP_(?:RUNNER_|NATIVE_|GITHUB_|ACPX_|VERIFIED_))/.test(upper);
}

function checkedNames(names: unknown): string[] {
  if (!Array.isArray(names) || names.length > 128 || names.some(name => typeof name !== "string" || !eligibleKey(name))
    || new Set(names).size !== names.length) throw new Error("Invalid configured environment projection");
  return (names as string[]).sort();
}

/** Mint at the server's resolved configuration boundary, before host inheritance. */
export function configuredEnvironmentProjection(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = checkedNames(Object.keys(source).filter(key => source[key] !== undefined && eligibleKey(key)));
  return configuredEnvironment({ ...source, [CONFIGURED_ENVIRONMENT_KEYS]: JSON.stringify(names) });
}

/** Accept only an explicitly supplied, controller-minted projection. */
export function configuredEnvironment(source: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const raw = source?.[CONFIGURED_ENVIRONMENT_KEYS];
  if (raw === undefined) return {};
  if (Buffer.byteLength(raw) > 20_000) throw new Error("Invalid configured environment projection");
  let names: string[];
  try { names = checkedNames(JSON.parse(raw)); } catch { throw new Error("Invalid configured environment projection"); }
  const result: NodeJS.ProcessEnv = {};
  let bytes = 0;
  for (const name of names) {
    const value = source?.[name];
    if (typeof value !== "string" || value.includes("\0")) throw new Error("Invalid configured environment value");
    const size = Buffer.byteLength(name) + Buffer.byteLength(value);
    bytes += size;
    if (size > 65_536 || bytes > 262_144) throw new Error("Configured environment exceeds its bounded launch size");
    result[name] = value;
  }
  result[CONFIGURED_ENVIRONMENT_KEYS] = JSON.stringify(names);
  return result;
}

export function configuredEnvironmentKeys(source: NodeJS.ProcessEnv | undefined): string[] {
  return Object.keys(configuredEnvironment(source)).filter(key => key !== CONFIGURED_ENVIRONMENT_KEYS).sort();
}
