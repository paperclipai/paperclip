import { logger } from "../middleware/logger.js";

export type PermissionDecision = "approve" | "deny";

interface PendingPermission {
  resolve: (decision: PermissionDecision) => void;
  timer: NodeJS.Timeout;
  sessionId: string;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

const pending = new Map<string, PendingPermission>();

export interface ChatPermissionStore {
  await: (toolUseId: string, sessionId: string, ttlMs?: number) => Promise<PermissionDecision>;
  resolve: (toolUseId: string, decision: PermissionDecision) => boolean;
  cancelSession: (sessionId: string) => void;
  hasPending: (toolUseId: string) => boolean;
}

export function chatPermissionStore(): ChatPermissionStore {
  return {
    await(toolUseId, sessionId, ttlMs = DEFAULT_TTL_MS) {
      return new Promise<PermissionDecision>((resolve) => {
        const existing = pending.get(toolUseId);
        if (existing) {
          clearTimeout(existing.timer);
          pending.delete(toolUseId);
          existing.resolve("deny");
        }
        const timer = setTimeout(() => {
          if (pending.delete(toolUseId)) {
            logger.warn({ toolUseId, sessionId }, "Chat permission request timed out, denying");
            resolve("deny");
          }
        }, ttlMs);
        timer.unref?.();
        pending.set(toolUseId, { resolve, timer, sessionId });
      });
    },

    resolve(toolUseId, decision) {
      const entry = pending.get(toolUseId);
      if (!entry) return false;
      clearTimeout(entry.timer);
      pending.delete(toolUseId);
      entry.resolve(decision);
      return true;
    },

    cancelSession(sessionId) {
      for (const [toolUseId, entry] of pending) {
        if (entry.sessionId === sessionId) {
          clearTimeout(entry.timer);
          pending.delete(toolUseId);
          entry.resolve("deny");
        }
      }
    },

    hasPending(toolUseId) {
      return pending.has(toolUseId);
    },
  };
}

export const chatPermissions = chatPermissionStore();
