import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Db } from "@paperclipai/db";
import { credentialService } from "./credentials.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaudeLoginSession {
  id: string;
  companyId: string;
  userId: string;
  credentialName: string;
  tempHome: string;
  loginUrl: string | null;
  status: "pending" | "waiting_for_code" | "exchanging" | "complete" | "failed" | "expired";
  credentialId: string | null;
  error: string | null;
  startedAt: number;
}

interface StartClaudeLoginOpts {
  companyId: string;
  userId: string;
  credentialName?: string;
  isDefault?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_PER_COMPANY = 3;
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const POLL_INTERVAL_MS = 2_000;
const SESSION_RETAIN_MS = 60_000;

// ---------------------------------------------------------------------------
// In-memory session store
// ---------------------------------------------------------------------------

const sessions = new Map<string, ClaudeLoginSession>();
const sessionProcesses = new Map<string, ChildProcess>();
const sessionTimers = new Map<string, NodeJS.Timeout>();
const sessionPollers = new Map<string, NodeJS.Timeout>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultCredentialName(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `Claude (${yyyy}-${mm}-${dd})`;
}

function countPendingForCompany(companyId: string): number {
  let count = 0;
  for (const s of sessions.values()) {
    if (s.companyId === companyId && (s.status === "pending" || s.status === "waiting_for_code" || s.status === "exchanging")) count++;
  }
  return count;
}

function scheduleRetention(sessionId: string) {
  const existing = sessionTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    sessions.delete(sessionId);
    sessionTimers.delete(sessionId);
  }, SESSION_RETAIN_MS);
  if (timer.unref) timer.unref();
  sessionTimers.set(sessionId, timer);
}

function cleanupSession(sessionId: string) {
  const poller = sessionPollers.get(sessionId);
  if (poller) {
    clearInterval(poller);
    sessionPollers.delete(sessionId);
  }

  const proc = sessionProcesses.get(sessionId);
  if (proc && !proc.killed) {
    proc.kill();
    sessionProcesses.delete(sessionId);
  }

  const session = sessions.get(sessionId);
  if (session?.tempHome) {
    fs.rm(session.tempHome, { recursive: true, force: true }).catch(() => {});
  }
}

function finalizeSession(
  sessionId: string,
  status: "complete" | "failed" | "expired",
  patch: Partial<Pick<ClaudeLoginSession, "credentialId" | "error">>,
) {
  const session = sessions.get(sessionId);
  if (!session || (session.status !== "pending" && session.status !== "waiting_for_code" && session.status !== "exchanging")) return;
  session.status = status;
  if (patch.credentialId !== undefined) session.credentialId = patch.credentialId;
  if (patch.error !== undefined) session.error = patch.error;
  cleanupSession(sessionId);
  scheduleRetention(sessionId);
}

// ---------------------------------------------------------------------------
// Credential file polling
// ---------------------------------------------------------------------------

function startPolling(db: Db, sessionId: string, isDefault: boolean | undefined) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const credFilePath = path.join(session.tempHome, ".claude", ".credentials.json");
  const svc = credentialService(db);

  const poller = setInterval(async () => {
    const current = sessions.get(sessionId);
    if (!current || (current.status !== "pending" && current.status !== "waiting_for_code" && current.status !== "exchanging")) {
      clearInterval(poller);
      sessionPollers.delete(sessionId);
      return;
    }

    try {
      const raw = await fs.readFile(credFilePath, "utf-8");
      const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
      const accessToken = parsed?.claudeAiOauth?.accessToken;
      if (!accessToken || typeof accessToken !== "string" || accessToken.trim().length === 0) return;

      logger.info({ sessionId }, "claude login: credentials.json found, creating credential");

      clearInterval(poller);
      sessionPollers.delete(sessionId);

      try {
        const created = await svc.create(current.companyId, {
          name: current.credentialName,
          type: "claude_oauth",
          credential: { accessToken },
          isDefault,
        });
        finalizeSession(sessionId, "complete", { credentialId: created.id });

        await logActivity(db, {
          companyId: current.companyId,
          actorType: "user",
          actorId: current.userId,
          action: "credential.created",
          entityType: "provider_credential",
          entityId: created.id,
          details: { name: current.credentialName, type: "claude_oauth", method: "claude_login" },
        }).catch((err) => {
          logger.warn({ err, sessionId }, "claude login: failed to log activity");
        });
      } catch (err) {
        finalizeSession(sessionId, "failed", {
          error: err instanceof Error ? err.message : "Failed to save credential",
        });
      }
    } catch {
      // File doesn't exist yet
    }
  }, POLL_INTERVAL_MS);

  if (poller.unref) poller.unref();
  sessionPollers.set(sessionId, poller);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function startClaudeLoginSession(
  db: Db,
  opts: StartClaudeLoginOpts,
): Promise<ClaudeLoginSession> {
  const { companyId, userId, isDefault } = opts;
  const credentialName = opts.credentialName?.trim() || defaultCredentialName();

  if (countPendingForCompany(companyId) >= MAX_CONCURRENT_PER_COMPANY) {
    throw new Error(`Too many pending Claude login sessions (max ${MAX_CONCURRENT_PER_COMPANY})`);
  }

  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-login-"));
  const sessionId = randomUUID();

  const session: ClaudeLoginSession = {
    id: sessionId,
    companyId,
    userId,
    credentialName,
    tempHome,
    loginUrl: null,
    status: "pending",
    credentialId: null,
    error: null,
    startedAt: Date.now(),
  };
  sessions.set(sessionId, session);

  // Start polling for credentials file (in case CLI auto-completes)
  startPolling(db, sessionId, isDefault);

  // Schedule expiry
  const expiryTimer = setTimeout(() => {
    const s = sessions.get(sessionId);
    if (s && s.status !== "complete" && s.status !== "failed") {
      finalizeSession(sessionId, "expired", { error: "Session timed out after 5 minutes" });
    }
  }, SESSION_TIMEOUT_MS);
  if (expiryTimer.unref) expiryTimer.unref();
  sessionTimers.set(`expiry:${sessionId}`, expiryTimer);

  // Spawn claude auth login with a pipe to stdin
  const env = { ...process.env, HOME: tempHome };
  const proc = spawn("claude", ["auth", "login"], {
    cwd: tempHome,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  sessionProcesses.set(sessionId, proc);

  let stdout = "";
  let stderr = "";

  proc.stdout?.on("data", (data: Buffer) => {
    const chunk = data.toString();
    stdout += chunk;
    logger.debug({ sessionId, stream: "stdout", chunk: chunk.slice(0, 300) }, "claude login output");

    // Capture login URL
    if (!session.loginUrl) {
      const urlMatch = chunk.match(/https:\/\/[^\s]+/);
      if (urlMatch) {
        session.loginUrl = urlMatch[0].replace(/[\])}.!,?;:'"]+$/g, "");
        session.status = "waiting_for_code";
        logger.info({ sessionId, loginUrl: session.loginUrl }, "claude login: captured login URL");
      }
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    const chunk = data.toString();
    stderr += chunk;
    logger.debug({ sessionId, stream: "stderr", chunk: chunk.slice(0, 300) }, "claude login output");

    // Also check stderr for URL
    if (!session.loginUrl) {
      const urlMatch = chunk.match(/https:\/\/[^\s]+/);
      if (urlMatch) {
        session.loginUrl = urlMatch[0].replace(/[\])}.!,?;:'"]+$/g, "");
        session.status = "waiting_for_code";
        logger.info({ sessionId, loginUrl: session.loginUrl }, "claude login: captured login URL from stderr");
      }
    }
  });

  proc.on("close", (code) => {
    const current = sessions.get(sessionId);
    if (!current || current.status === "complete") return;

    if (code === 0) {
      // Success — polling should pick up the credentials file
      logger.info({ sessionId }, "claude login: process exited successfully");
    } else if (current.status !== "failed" && current.status !== "expired") {
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join(" | ");
      const errMsg = detail || `claude auth login exited with code ${code}`;
      logger.warn({ sessionId, code, stderr: stderr.slice(0, 500) }, "claude login: process failed");
      finalizeSession(sessionId, "failed", { error: errMsg });
    }
  });

  proc.on("error", (err) => {
    logger.error({ sessionId, err }, "claude login: spawn error");
    finalizeSession(sessionId, "failed", { error: err.message });
  });

  // Wait for URL to appear
  await new Promise((resolve) => setTimeout(resolve, 2000));

  return session;
}

/**
 * Submit the authentication code from the browser back to the running
 * `claude auth login` process via stdin.
 */
export function submitAuthCode(sessionId: string, code: string): boolean {
  const session = sessions.get(sessionId);
  if (!session || session.status !== "waiting_for_code") return false;

  const proc = sessionProcesses.get(sessionId);
  if (!proc || proc.killed || !proc.stdin?.writable) return false;

  session.status = "exchanging";
  proc.stdin.write(code.trim() + "\n");
  logger.info({ sessionId }, "claude login: auth code submitted to stdin");
  return true;
}

export function getClaudeLoginSession(sessionId: string): ClaudeLoginSession | null {
  return sessions.get(sessionId) ?? null;
}

export function cancelClaudeLoginSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;

  if (session.status !== "complete" && session.status !== "failed") {
    finalizeSession(sessionId, "failed", { error: "Cancelled by user" });
  }

  const expiryTimer = sessionTimers.get(`expiry:${sessionId}`);
  if (expiryTimer) {
    clearTimeout(expiryTimer);
    sessionTimers.delete(`expiry:${sessionId}`);
  }

  return true;
}
