import type { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import { DEFAULT_SESSION_ID } from "./sandboxes.js";

export type SessionStrategy = "named" | "default";

export interface ResolvedSession {
  exec(
    command: string,
    options?: {
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      stdin?: string | null;
      timeout?: number;
      stream?: boolean;
      onOutput?: (stream: "stdout" | "stderr", data: string) => void | Promise<void>;
    },
  ): Promise<{ success?: boolean; stdout?: string; stderr?: string; exitCode?: number | null }>;
}

export async function getNamedSession(
  sandbox: CloudflareSandbox,
  options: {
    sessionId?: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<ResolvedSession> {
  const sessionId = options.sessionId?.trim() || DEFAULT_SESSION_ID;
  try {
    return await sandbox.getSession(sessionId);
  } catch (err) {
    // Only fall through to `createSession` for the "session not found" case.
    // The Sandbox SDK currently surfaces missing-session as an Error whose
    // message contains "not found" / "does not exist"; any other failure
    // (quota exceeded, sandbox destroyed mid-request, malformed ID) should
    // bubble up so callers see the real cause instead of a confusing
    // secondary `createSession` error that hides the root cause.
    if (!isSessionNotFoundError(err)) throw err;
    // Create the session without pinning it to a workspace path up front.
    // Workspace preparation may be the first thing we do with the session.
    return await sandbox.createSession({
      id: sessionId,
      env: options.env,
      commandTimeoutMs: options.timeoutMs,
    });
  }
}

function isSessionNotFoundError(err: unknown): boolean {
  if (!err) return false;
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /not\s*found|does\s*not\s*exist|no\s+such\s+session/i.test(message);
}

export async function resolveExecutionTarget(
  sandbox: CloudflareSandbox,
  options: {
    sessionStrategy: SessionStrategy;
    sessionId?: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<ResolvedSession | CloudflareSandbox> {
  if (options.sessionStrategy === "default") return sandbox;
  return await getNamedSession(sandbox, options);
}

export async function cleanupTimedOutExecution(
  sandbox: CloudflareSandbox,
  options: {
    sessionStrategy: SessionStrategy;
    sessionId?: string;
  },
): Promise<void> {
  if (options.sessionStrategy === "default") {
    await sandbox.destroy().catch(() => undefined);
    return;
  }
  await sandbox.deleteSession(options.sessionId?.trim() || DEFAULT_SESSION_ID).catch(() => undefined);
}
