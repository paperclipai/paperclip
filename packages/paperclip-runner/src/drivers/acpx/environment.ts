import { configuredEnvironment } from "../../configured-environment.js";
import type { QualifiedAcpxAgent } from "./qualified-profiles.js";

export const ACPX_CREDENTIAL_BINDING_ENV = "PAPERCLIP_ACPX_CREDENTIAL_BINDING";
export const ACPX_CREDENTIAL_NAMES: Readonly<Record<QualifiedAcpxAgent, readonly string[]>> = {
  grok: ["XAI_API_KEY"],
  pi: ["OPENROUTER_API_KEY"],
  cursor: ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"],
  copilot: ["COPILOT_GITHUB_TOKEN"],
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "AWS_BEARER_TOKEN_BEDROCK"],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY", "PAPERCLIP_AI_PROVIDER_KEY"],
};
export const CLAUDE_ROUTING_ENV_KEYS = ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_EC2_METADATA_DISABLED", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"] as const;
const isCandidate = (agent: QualifiedAcpxAgent) => agent === "pi" || agent === "cursor" || agent === "copilot";

/** Mint only at the controller's explicit task-environment boundary, never by copying a marker. */
export function createAcpxCredentialBinding(
  environment: NodeJS.ProcessEnv | undefined,
  agent: QualifiedAcpxAgent,
  sessionId: string,
): string | undefined {
  if (!isCandidate(agent)) return undefined;
  return JSON.stringify({
    schema: "paperclip.acpx_credential_binding.v1", agent, sessionId,
    names: ACPX_CREDENTIAL_NAMES[agent].filter(name => environment !== undefined
      && Object.hasOwn(environment, name) && Boolean(environment[name]?.trim())),
  });
}

/** process.env at the sidecar is not itself proof of a task credential binding. */
export function createAcpxSidecarHostEnvironment(
  environment: NodeJS.ProcessEnv,
  agent: QualifiedAcpxAgent,
  sessionId: string,
): NodeJS.ProcessEnv {
  if (!isCandidate(agent)) return environment;
  const invalid = () => new Error("Candidate ACPX credentials require an explicit matching session binding");
  const raw = environment[ACPX_CREDENTIAL_BINDING_ENV];
  let names: string[] = [];
  if (raw !== undefined) {
    if (Buffer.byteLength(raw) > 4_096) throw invalid();
    let binding: unknown;
    try { binding = JSON.parse(raw); } catch { throw invalid(); }
    if (binding === null || typeof binding !== "object" || Array.isArray(binding)) throw invalid();
    const value = binding as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "agent,names,schema,sessionId"
      || value.schema !== "paperclip.acpx_credential_binding.v1" || value.agent !== agent
      || value.sessionId !== sessionId || !Array.isArray(value.names)
      || value.names.length > ACPX_CREDENTIAL_NAMES[agent].length
      || value.names.some(name => typeof name !== "string" || !ACPX_CREDENTIAL_NAMES[agent].includes(name))
      || new Set(value.names).size !== value.names.length) throw invalid();
    names = value.names as string[];
  }
  const result = { ...environment };
  delete result[ACPX_CREDENTIAL_BINDING_ENV];
  for (const name of ACPX_CREDENTIAL_NAMES[agent]) {
    if (names.includes(name)) {
      if (!Object.hasOwn(environment, name) || !environment[name]?.trim()) throw invalid();
    } else {
      if (environment[name]?.trim()) throw invalid();
      delete result[name];
    }
  }
  return result;
}

declare const sanitizedAcpxSpawnInputBrand: unique symbol;

/**
 * Opaque child-process input produced only after the host environment crosses
 * the ACPX credential allowlist. Future ACPX launchers accept this boundary
 * object rather than an arbitrary `process.env`-shaped value.
 */
export interface SanitizedAcpxSpawnInput {
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly [sanitizedAcpxSpawnInputBrand]: true;
}

/**
 * Build the only host-environment input that may cross an ACPX child-process
 * launch boundary. Agent-specific homes are added by the later runtime sandbox;
 * Paperclip transport and native MCP credentials are never inherited from the
 * host process.
 */
export function createSanitizedAcpxSpawnInput(
  environment: NodeJS.ProcessEnv | undefined,
  agent: QualifiedAcpxAgent,
): SanitizedAcpxSpawnInput {
  const source = environment ?? process.env;
  const candidate = isCandidate(agent);
  const result: NodeJS.ProcessEnv = configuredEnvironment(environment);
  const credentialNames = ACPX_CREDENTIAL_NAMES[agent];
  const allowed = new Set([
    "PATH",
    "LANG",
    "LANGUAGE",
    "TZ",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
    "RUST_BACKTRACE",
    "PAPERCLIP_NATIVE_MCP_NAME",
    "PAPERCLIP_NATIVE_MCP_URL",
    ...(environment === undefined ? [] : ["PAPERCLIP_AGENT_KEY_ID", "PAPERCLIP_AGENT_PUBLIC_KEY", "PAPERCLIP_AGENT_PRIVATE_KEY"]),
    ...credentialNames,
    ...(agent === "claude" ? CLAUDE_ROUTING_ENV_KEYS : []),
  ]);
  let retainedBytes = 0;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    // Candidate credentials must be explicitly bound to this run. Locale and
    // transport settings may come from the host; login state never does.
    if (candidate && environment === undefined && credentialNames.includes(key)) continue;
    if (!allowed.has(key) && !/^LC_[A-Z0-9_]{1,32}$/.test(key)) continue;
    if (key.includes("\0") || value.includes("\0")) {
      throw new Error("ACPX environment contains a null byte");
    }
    const entryBytes = Buffer.byteLength(key) + Buffer.byteLength(value);
    if (entryBytes > 64 * 1024 || retainedBytes + entryBytes > 256 * 1024) {
      throw new Error("ACPX environment exceeds its bounded launch size");
    }
    retainedBytes += entryBytes;
    result[key] = value;
  }
  return Object.freeze({
    env: Object.freeze(result),
  }) as SanitizedAcpxSpawnInput;
}
