import { createHash } from "node:crypto";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildPaperclipEnv, parseObject } from "@paperclipai/adapter-utils/server-utils";

export const RESERVED_SESSION_ENV_NAMES = new Set(["SERVER_ENDPOINT", "USER_ID", "WORK_DIR"]);

export const RESERVED_SESSION_ENV_PREFIXES = ["CAW_", "QODER_"];

export const SESSION_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const SESSION_ENV_MAX_ENTRIES = 64;

export const SESSION_ENV_MAX_VALUE_BYTES = 8 * 1024;

export const SESSION_ENV_MAX_TOTAL_BYTES = 64 * 1024;

/**
 * Qoder fixes session env vars at creation, so only values that stay stable
 * across heartbeats belong here; run-scoped values travel in the prompt.
 *
 * The resolved config env also carries variables Paperclip injects for a local
 * child process (TMPDIR, scratch dirs, SSH_AUTH_SOCK, host paths). Those are
 * meaningless in a remote container and change every run, so only the keys the
 * operator saved on the agent are forwarded.
 */
export function buildSessionEnv(
  ctx: AdapterExecutionContext,
  configEnv: Record<string, string>,
): { env: Record<string, string>; dropped: string[] } {
  const operatorKeys = new Set(Object.keys(parseObject(parseObject(ctx.agent.adapterConfig).env)));
  const candidate: Record<string, string> = {
    ...Object.fromEntries(Object.entries(configEnv).filter(([key]) => operatorKeys.has(key))),
    ...buildPaperclipEnv(ctx.agent),
  };
  // No Paperclip run token reaches Qoder (registry: supportsLocalAgentJwt=false),
  // so drop the callback wiring instead of pointing the agent at an API it
  // cannot authenticate against.
  delete candidate.PAPERCLIP_API_KEY;
  delete candidate.PAPERCLIP_API_URL;
  delete candidate.PAPERCLIP_API_BRIDGE_MODE;
  delete candidate.PAPERCLIP_WAKE_PAYLOAD_JSON;

  const env: Record<string, string> = {};
  const dropped: string[] = [];
  let totalBytes = 0;
  for (const key of Object.keys(candidate).sort()) {
    const value = candidate[key];
    // Qoder credentials are adapter inputs, not session env.
    if (RESERVED_SESSION_ENV_PREFIXES.some((prefix) => key.toUpperCase().startsWith(prefix))) continue;
    if (value.length === 0) continue;
    const valueBytes = Buffer.byteLength(value, "utf8");
    const entryBytes = Buffer.byteLength(key, "utf8") + valueBytes;
    if (
      !SESSION_ENV_NAME_PATTERN.test(key) ||
      RESERVED_SESSION_ENV_NAMES.has(key) ||
      valueBytes > SESSION_ENV_MAX_VALUE_BYTES ||
      Object.keys(env).length >= SESSION_ENV_MAX_ENTRIES ||
      totalBytes + entryBytes > SESSION_ENV_MAX_TOTAL_BYTES
    ) {
      dropped.push(key);
      continue;
    }
    env[key] = value;
    totalBytes += entryBytes;
  }
  return { env, dropped };
}

export function fingerprintSecret(value: string | null): string | null {
  return value ? createHash("sha256").update(value).digest("hex").slice(0, 32) : null;
}

export function fingerprintEnv(env: Record<string, string>): string {
  const entries = Object.keys(env).sort().map((key) => [key, env[key]]);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
