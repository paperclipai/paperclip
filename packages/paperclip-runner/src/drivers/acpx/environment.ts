import type { QualifiedAcpxAgent } from "./qualified-profiles.js";

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
  const result: NodeJS.ProcessEnv = {};
  const credentialNames =
    agent === "pi"
      ? ["OPENROUTER_API_KEY"]
      : agent === "claude"
        ? ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]
        : [
            "OPENAI_API_KEY",
            "CODEX_API_KEY",
          ];
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
    ...credentialNames,
  ]);
  let retainedBytes = 0;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
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
