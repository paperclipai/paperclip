import { logger } from "../middleware/logger.js";

export type PermissionDecision = "approve" | "deny";

interface PendingPermission {
  resolve: (decision: PermissionDecision) => void;
  timer: NodeJS.Timeout;
  sessionId: string;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

// Keyed by `${sessionId}:${toolUseId}` so two concurrent sessions that
// happen to mint the same toolUseId (synthetic ids like `call_0` from
// OpenAI/Gemini fallbacks) can't collide.
const pending = new Map<string, PendingPermission>();

function permKey(sessionId: string, toolUseId: string): string {
  return `${sessionId}\x00${toolUseId}`;
}

export interface ChatPermissionStore {
  await: (toolUseId: string, sessionId: string, ttlMs?: number) => Promise<PermissionDecision>;
  resolve: (sessionId: string, toolUseId: string, decision: PermissionDecision) => boolean;
  cancelSession: (sessionId: string) => void;
  hasPending: (sessionId: string, toolUseId: string) => boolean;
}

export function chatPermissionStore(): ChatPermissionStore {
  return {
    await(toolUseId, sessionId, ttlMs = DEFAULT_TTL_MS) {
      return new Promise<PermissionDecision>((resolve) => {
        const key = permKey(sessionId, toolUseId);
        const existing = pending.get(key);
        if (existing) {
          clearTimeout(existing.timer);
          pending.delete(key);
          existing.resolve("deny");
        }
        const timer = setTimeout(() => {
          if (pending.delete(key)) {
            logger.warn({ toolUseId, sessionId }, "Chat permission request timed out, denying");
            resolve("deny");
          }
        }, ttlMs);
        timer.unref?.();
        pending.set(key, { resolve, timer, sessionId });
      });
    },

    resolve(sessionId, toolUseId, decision) {
      const key = permKey(sessionId, toolUseId);
      const entry = pending.get(key);
      if (!entry) return false;
      clearTimeout(entry.timer);
      pending.delete(key);
      entry.resolve(decision);
      return true;
    },

    cancelSession(sessionId) {
      for (const [key, entry] of pending) {
        if (entry.sessionId === sessionId) {
          clearTimeout(entry.timer);
          pending.delete(key);
          entry.resolve("deny");
        }
      }
    },

    hasPending(sessionId, toolUseId) {
      return pending.has(permKey(sessionId, toolUseId));
    },
  };
}

export const chatPermissions = chatPermissionStore();
