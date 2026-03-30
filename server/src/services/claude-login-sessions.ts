import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { runClaudeLogin } from "@paperclipai/adapter-claude-local/server";
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
  status: "pending" | "complete" | "failed" | "expired";
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
const SESSION_RETAIN_MS = 60_000; // keep completed sessions for 60s

// ---------------------------------------------------------------------------
// In-memory session store
// ---------------------------------------------------------------------------

const sessions = new Map<string, ClaudeLoginSession>();
const sessionTimers = new Map<string, NodeJS.Timeout>();
const sessionPollers = new Map<string, NodeJS.Timeout>();
const sessionAbortControllers = new Map<string, AbortController>();

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
    if (s.companyId === companyId && s.status === "pending") count++;
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
  // Prevent the timer from keeping the process alive
  if (timer.unref) timer.unref();
  sessionTimers.set(sessionId, timer);
}

function cleanupSession(sessionId: string) {
  const poller = sessionPollers.get(sessionId);
  if (poller) {
    clearInterval(poller);
    sessionPollers.delete(sessionId);
  }

  const ac = sessionAbortControllers.get(sessionId);
  if (ac) {
    ac.abort();
    sessionAbortControllers.delete(sessionId);
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
  if (!session || session.status !== "pending") return;
  session.status = status;
  if (patch.credentialId !== undefined) session.credentialId = patch.credentialId;
  if (patch.error !== undefined) session.error = patch.error;
  cleanupSession(sessionId);
  scheduleRetention(sessionId);
}

// ---------------------------------------------------------------------------
// Credential file polling
// ---------------------------------------------------------------------------

function startPolling(
  db: Db,
  sessionId: string,
  isDefault: boolean | undefined,
) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const credFilePath = path.join(session.tempHome, ".claude", ".credentials.json");

  const poller = setInterval(async () => {
    // Guard: stop if session is no longer pending
    const current = sessions.get(sessionId);
    if (!current || current.status !== "pending") {
      clearInterval(poller);
      sessionPollers.delete(sessionId);
      return;
    }

    try {
      const raw = await fs.readFile(credFilePath, "utf-8");
      const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
      const accessToken = parsed?.claudeAiOauth?.accessToken;
      if (!accessToken) return; // File exists but no token yet

      logger.info({ sessionId }, "claude login: credentials.json found, creating credential");

      const creds = credentialService(db);
      const created = await creds.create(current.companyId, {
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
        details: {
          name: current.credentialName,
          type: "claude_oauth",
          method: "claude_login",
          sessionId,
        },
      }).catch((err) => {
        logger.warn({ err, sessionId }, "claude login: failed to log activity");
      });
    } catch {
      // File doesn't exist yet or isn't valid JSON — keep polling
    }
  }, POLL_INTERVAL_MS);

  if (poller.unref) poller.unref();
  sessionPollers.set(sessionId, poller);
}

// ---------------------------------------------------------------------------
// Timeout watcher
// ---------------------------------------------------------------------------

function scheduleExpiry(sessionId: string) {
  const timer = setTimeout(() => {
    const session = sessions.get(sessionId);
    if (session && session.status === "pending") {
      logger.info({ sessionId }, "claude login: session expired");
      finalizeSession(sessionId, "expired", { error: "Session timed out after 5 minutes" });
    }
  }, SESSION_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  // Store in a secondary map so we can clear on cancel
  sessionTimers.set(`expiry:${sessionId}`, timer);
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

  // Enforce concurrency limit
  if (countPendingForCompany(companyId) >= MAX_CONCURRENT_PER_COMPANY) {
    throw new Error(
      `Too many pending Claude login sessions for this company (max ${MAX_CONCURRENT_PER_COMPANY})`,
    );
  }

  // Create temp HOME
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

  // Abort controller so we can kill the child process on cancel
  const ac = new AbortController();
  sessionAbortControllers.set(sessionId, ac);

  // Start polling for credentials file
  startPolling(db, sessionId, isDefault);

  // Schedule expiry
  scheduleExpiry(sessionId);

  // Launch claude login in background — don't await it (it blocks until user completes)
  const loginPromise = runClaudeLogin({
    runId: `claude-login-${sessionId}`,
    agent: {
      id: "system",
      companyId,
      name: "Claude Login",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    config: {
      command: "claude",
      env: { HOME: tempHome },
    },
    onLog: async (_stream, chunk) => {
      // Capture login URL from stdout stream
      const current = sessions.get(sessionId);
      if (!current || current.loginUrl) return;

      // The claude login command outputs a URL — look for https:// pattern
      const urlMatch = chunk.match(/https:\/\/[^\s]+/);
      if (urlMatch) {
        current.loginUrl = urlMatch[0];
        logger.info({ sessionId, loginUrl: current.loginUrl }, "claude login: captured login URL");
      }
    },
  });

  loginPromise
    .then((result) => {
      const current = sessions.get(sessionId);
      if (!current || current.status !== "pending") return;

      // If runClaudeLogin returned a loginUrl and we haven't captured one yet, use it
      if (result.loginUrl && !current.loginUrl) {
        current.loginUrl = result.loginUrl;
      }

      // If the process exited with an error and we haven't completed, mark failed
      if (result.exitCode !== 0 && current.status === "pending") {
        const errMsg = result.stderr?.trim() || `claude login exited with code ${result.exitCode}`;
        finalizeSession(sessionId, "failed", { error: errMsg });
      }
      // If exitCode is 0, the polling should pick up the credentials file
    })
    .catch((err) => {
      const current = sessions.get(sessionId);
      if (!current || current.status !== "pending") return;
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err, sessionId }, "claude login: process error");
      finalizeSession(sessionId, "failed", { error: errMsg });
    });

  // Wait briefly for the URL to appear from stdout streaming
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Also try to extract from the result if loginUrl was populated via the sync return
  return session;
}

export function getClaudeLoginSession(sessionId: string): ClaudeLoginSession | null {
  return sessions.get(sessionId) ?? null;
}

export function cancelClaudeLoginSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;

  if (session.status === "pending") {
    finalizeSession(sessionId, "failed", { error: "Cancelled by user" });
  }

  // Clear the expiry timer
  const expiryTimer = sessionTimers.get(`expiry:${sessionId}`);
  if (expiryTimer) {
    clearTimeout(expiryTimer);
    sessionTimers.delete(`expiry:${sessionId}`);
  }

  return true;
}
