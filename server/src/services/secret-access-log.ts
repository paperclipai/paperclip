import type { Db } from "@paperclipai/db";
import { secretAccessLog } from "@paperclipai/db";
import type { companySecrets } from "@paperclipai/db";

const READ_LOG_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

interface PendingReadLog {
  secretId: string;
  secretName: string;
  companyId: string;
  actorAgentId: string | null;
  actorRole: string | null;
  createdAt: Date;
}

let pendingReads: PendingReadLog[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

export function startAccessLogFlusher(db: Db) {
  if (flushTimer) return;
  flushTimer = setInterval(() => flushPendingReads(db), READ_LOG_FLUSH_INTERVAL_MS);
}

export function stopAccessLogFlusher() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

export async function flushPendingReads(db: Db) {
  if (pendingReads.length === 0) return;
  const toFlush = pendingReads.splice(0, pendingReads.length);
  await db.insert(secretAccessLog).values(
    toFlush.map((r) => ({
      secretId: r.secretId,
      secretName: r.secretName,
      companyId: r.companyId,
      actorAgentId: r.actorAgentId,
      actorRole: r.actorRole,
      accessGranted: true,
      denialReason: null,
    })),
  );
}

export async function logAccessDenied(
  db: Db,
  input: {
    secretId: string;
    secretName: string;
    companyId: string;
    actorAgentId: string | null;
    actorRole: string | null;
    denialReason: string;
  },
) {
  await db.insert(secretAccessLog).values({
    secretId: input.secretId,
    secretName: input.secretName,
    companyId: input.companyId,
    actorAgentId: input.actorAgentId,
    actorRole: input.actorRole,
    accessGranted: false,
    denialReason: input.denialReason,
  });
}

export function queueAccessLogRead(input: {
  secretId: string;
  secretName: string;
  companyId: string;
  actorAgentId: string | null;
  actorRole: string | null;
}) {
  pendingReads.push({ ...input, createdAt: new Date() });
}

export function checkAcl(
  secret: typeof companySecrets.$inferSelect,
  agentId: string,
  agentRole: string,
): { granted: boolean; reason?: string } {
  const allowedRoles = secret.allowedAgentRoles ?? [];
  const allowedIds = secret.allowedAgentIds ?? [];

  if (allowedIds.length > 0 && allowedIds.includes(agentId)) {
    return { granted: true };
  }

  if (allowedRoles.length > 0 && allowedRoles.includes(agentRole)) {
    return { granted: true };
  }

  if (allowedRoles.length === 0 && allowedIds.length === 0) {
    return { granted: false, reason: "secret_has_no_acl_configured" };
  }

  return { granted: false, reason: "agent_not_in_acl" };
}