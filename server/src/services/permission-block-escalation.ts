import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";

export type PermissionBlockTrigger = "missing_permission" | "unblock_owner_role" | "board_approval_phrase";

export type PermissionBlockMatch = {
  trigger: PermissionBlockTrigger;
  /** Permission key the comment named, if any. e.g. "agents:create". */
  permissionKey: string | null;
  /** Role the comment names as the unblock owner. Always "ceo" today. */
  unblockOwnerRole: "ceo";
};

/**
 * Patterns a direct-report agent uses to signal "I can't move; my manager has the lever."
 * Conservative on purpose — we only fire CEO wakes when the comment is unambiguous.
 */
const MISSING_PERMISSION_RE = /missing\s+permission\s*[:\-]\s*([A-Za-z0-9_.:\-]+)/i;
const UNBLOCK_OWNER_RE = /unblock\s+owner\s*[:\-]\s*(ceo|board)\b/i;
const BOARD_APPROVAL_RE = /requires\s+board\s+approval\s+and\s+ceo\s+action/i;

export function detectPermissionBlockMarker(body: string | null | undefined): PermissionBlockMatch | null {
  if (!body || typeof body !== "string") return null;
  const missing = MISSING_PERMISSION_RE.exec(body);
  if (missing) {
    return { trigger: "missing_permission", permissionKey: missing[1] ?? null, unblockOwnerRole: "ceo" };
  }
  if (UNBLOCK_OWNER_RE.test(body)) {
    return { trigger: "unblock_owner_role", permissionKey: null, unblockOwnerRole: "ceo" };
  }
  if (BOARD_APPROVAL_RE.test(body)) {
    return { trigger: "board_approval_phrase", permissionKey: null, unblockOwnerRole: "ceo" };
  }
  return null;
}

type UnblockOwnerAgentRow = {
  id: string;
  role: string;
  status: string | null;
};

export function permissionBlockEscalationService(db: Db) {
  /**
   * Resolve the CEO-tier agent in this company that should receive an escalation wake.
   * Prefers role=ceo, falls back to cto (mirrors recovery/service.ts stale-run escalation order).
   * Skips terminated / pending_approval agents and the agent that authored the blocked comment.
   */
  async function findUnblockOwnerAgent(input: {
    companyId: string;
    excludeAgentId: string | null;
  }): Promise<UnblockOwnerAgentRow | null> {
    const rows = await db
      .select({ id: agents.id, role: agents.role, status: agents.status, createdAt: agents.createdAt })
      .from(agents)
      .where(and(eq(agents.companyId, input.companyId), inArray(agents.role, ["ceo", "cto"])))
      .orderBy(sql`case when ${agents.role} = 'ceo' then 0 else 1 end`, asc(agents.createdAt));
    for (const row of rows) {
      if (row.status === "pending_approval" || row.status === "terminated") continue;
      if (input.excludeAgentId && row.id === input.excludeAgentId) continue;
      return { id: row.id, role: row.role, status: row.status };
    }
    return null;
  }

  /**
   * Evaluate whether a blocked-issue comment should auto-wake the CEO.
   * Returns null when the issue is not blocked, the actor is not an agent, the
   * comment does not name a permission gate, or no CEO/CTO agent is available.
   */
  async function evaluate(input: {
    companyId: string;
    issueStatus: string;
    actorAgentId: string | null;
    commentBody: string | null | undefined;
  }): Promise<{ targetAgentId: string; targetAgentRole: string; match: PermissionBlockMatch } | null> {
    if (input.issueStatus !== "blocked") return null;
    if (!input.actorAgentId) return null;
    const match = detectPermissionBlockMarker(input.commentBody);
    if (!match) return null;
    const target = await findUnblockOwnerAgent({
      companyId: input.companyId,
      excludeAgentId: input.actorAgentId,
    });
    if (!target) return null;
    return { targetAgentId: target.id, targetAgentRole: target.role, match };
  }

  return { evaluate, findUnblockOwnerAgent };
}

export type PermissionBlockEscalationService = ReturnType<typeof permissionBlockEscalationService>;
