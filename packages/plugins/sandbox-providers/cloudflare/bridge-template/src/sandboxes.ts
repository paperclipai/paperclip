import type { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import { getSandbox } from "@cloudflare/sandbox";
import { buildLeaseSandboxId, buildSentinelPath, isTimeoutError } from "./helpers.js";

export interface BridgeEnv {
  Sandbox: DurableObjectNamespace<CloudflareSandbox>;
  BRIDGE_AUTH_TOKEN?: string;
}

export interface BridgeLeaseConfig {
  keepAlive: boolean;
  sleepAfter: string;
  normalizeId: boolean;
}

export const DEFAULT_REMOTE_CWD = "/workspace/paperclip";
export const DEFAULT_SESSION_ID = "paperclip";
export const DEFAULT_TIMEOUT_MS = 300_000;
export const LEASE_SENTINEL_FILE = ".paperclip-lease.json";

export function toJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

export function toErrorResponse(status: number, error: string, message: string, details?: unknown): Response {
  return toJsonResponse({ error, message, details }, status);
}

export async function resolveSandbox(
  env: BridgeEnv,
  sandboxId: string,
  config: BridgeLeaseConfig,
): Promise<CloudflareSandbox> {
  // Pure handle resolution: the constructor accepts keepAlive/sleepAfter so the
  // sandbox is created with the right defaults on first use, but we no longer
  // call `setKeepAlive` here. That side effect now lives in
  // `applySandboxKeepAlive` and is invoked only from lease-management routes,
  // so exec calls don't accidentally overwrite the lease's keepAlive policy.
  return getSandbox(env.Sandbox, sandboxId, {
    keepAlive: config.keepAlive,
    sleepAfter: config.sleepAfter,
  });
}

export async function applySandboxKeepAlive(
  sandbox: CloudflareSandbox,
  keepAlive: boolean,
): Promise<void> {
  await sandbox.setKeepAlive(keepAlive);
}

export { buildLeaseSandboxId, buildSentinelPath, isTimeoutError };
