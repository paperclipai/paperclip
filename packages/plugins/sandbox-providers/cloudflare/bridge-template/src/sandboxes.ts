import type { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import { getSandbox } from "@cloudflare/sandbox";
import { buildLeaseSandboxId, buildSentinelPath, isTimeoutError } from "./helpers.js";

export interface BridgeEnv {
  Sandbox: DurableObjectNamespace<CloudflareSandbox>;
  BRIDGE_AUTH_TOKEN?: string;
}

export interface BridgeLeaseConfig {
  keepAlive?: boolean;
  sleepAfter?: string;
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
    ...(config.keepAlive !== undefined ? { keepAlive: config.keepAlive } : {}),
    ...(config.sleepAfter !== undefined ? { sleepAfter: config.sleepAfter } : {}),
  });
}

export const DESTROY_ATTEMPTS = 3;
export const DESTROY_ATTEMPT_TIMEOUT_MS = 20_000;
export const DESTROY_BACKOFF_MS = [500, 2_000] as const;

export type DestroyOutcome =
  | { ok: true; attempts: number }
  | { ok: false; attempts: number; error: string };

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sandbox.destroy() timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export async function destroySandbox(
  sandbox: Pick<CloudflareSandbox, "destroy">,
  context: { route: string; providerLeaseId: string },
  options: { attempts?: number; timeoutMs?: number; backoffMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DestroyOutcome> {
  const attempts = options.attempts ?? DESTROY_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? DESTROY_ATTEMPT_TIMEOUT_MS;
  const backoffMs = options.backoffMs ?? DESTROY_BACKOFF_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError = "unknown error";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await withTimeout(Promise.resolve().then(() => sandbox.destroy()), timeoutMs);
      if (attempt > 1) {
        console.log(JSON.stringify({ event: "sandbox.destroy.recovered", ...context, attempt }));
      }
      return { ok: true, attempts: attempt };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: "sandbox.destroy.failed", ...context, attempt, attempts, error: lastError }));
      if (attempt < attempts) {
        await sleep(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 0);
      }
    }
  }
  return { ok: false, attempts, error: lastError };
}

export async function applySandboxKeepAlive(
  sandbox: CloudflareSandbox,
  keepAlive: boolean,
): Promise<void> {
  await sandbox.setKeepAlive(keepAlive);
}

export { buildLeaseSandboxId, buildSentinelPath, isTimeoutError };
