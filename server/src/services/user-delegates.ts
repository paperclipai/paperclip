import { and, eq } from "drizzle-orm";
import { agents, companyMemberships, userDelegates, type Db } from "@paperclipai/db";
import type { UserDelegate, UserDelegateActionDescriptor } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

const ID = "[^/]+";

interface UserDelegateAction extends UserDelegateActionDescriptor {
  pattern: RegExp;
}

function action(key: string, method: string, path: string, description: string): UserDelegateAction {
  const source = path.replace(/:[A-Za-z]+/g, ID).replace(/\((?!\?)/g, "(?:");
  return { key, method, path, description, pattern: new RegExp(`^${source}/?$`) };
}

/**
 * The person-only actions a named delegate may perform as that person. Each
 * entry is an exact method and route; everything else stays person-only.
 * Deliberately excluded: approvals, budgets, agent permissions and keys,
 * hires, secrets, sign-ins, board API keys, invites, delegate management,
 * routine secret rotation, agent termination and destructive workspace repair.
 */
export const USER_DELEGATE_ACTIONS: readonly UserDelegateAction[] = [
  action("interaction.resolve", "POST", "/api/issues/:id/interactions/:interactionId/(accept|reject|respond|dismiss|withdraw)",
    "Answer, accept, reject, defer or withdraw a task card addressed to the person"),
  action("decision.decide", "POST", "/api/decisions/:id/(decide|dismiss)", "Decide or dismiss an item on the decisions page"),
  action("routine.create", "POST", "/api/companies/:companyId/routines", "Create a routine for any agent"),
  action("routine.update", "PATCH", "/api/routines/:id", "Change any agent's routine"),
  action("routine.run", "POST", "/api/routines/:id/run", "Run any agent's routine now"),
  action("routine.trigger_create", "POST", "/api/routines/:id/triggers", "Add a routine schedule or trigger"),
  action("routine.trigger_update", "PATCH", "/api/routine-triggers/:id", "Change a routine schedule or trigger"),
  action("routine.trigger_delete", "DELETE", "/api/routine-triggers/:id", "Remove a routine schedule or trigger"),
  action("agent.wake", "POST", "/api/agents/:id/(wakeup|heartbeat/invoke)", "Wake another agent"),
  action("agent.pause_resume", "POST", "/api/agents/:id/(pause|resume)", "Pause or resume another agent"),
  action("tools.review_new", "POST", "/api/tool-profiles/:profileId/new-tools/review", "Review new catalog tools and turn them on or off"),
  action("tools.policy_create", "POST", "/api/companies/:companyId/tools/policies(/reorder|/:policyId/duplicate)?", "Create, reorder or copy tool rules"),
  action("tools.policy_update", "PATCH", "/api/companies/:companyId/tools/policies/:policyId", "Change a tool rule"),
  action("tools.policy_delete", "DELETE", "/api/companies/:companyId/tools/policies/:policyId", "Remove a tool rule"),
  action("composio.account_add", "POST", "/api/tool-connections/:connectionId/composio/apps/:toolkit/accounts",
    "Start adding a Composio account; the person still completes the provider sign-in"),
  action("stalled.review_decision", "POST", "/api/issues/:id/stalled-review-decision", "Decide a stalled-task review"),
  action("recovery.resolve", "POST", "/api/issues/:id/recovery-actions/resolve", "Resolve a recovery item"),
  action("recovery.workspace", "POST", "/api/issues/:id/recovery-actions/(recover-workspace|resume-workspace-finalization|retry-workspace-export)",
    "Retry a task's workspace recovery"),
  action("task.retry", "POST", "/api/issues/:id/(retry|scheduled-retry/retry-now)", "Retry a failed or scheduled task run"),
  action("watchdog.decide", "POST", "/api/heartbeat-runs/:runId/watchdog-decisions", "Decide a stuck-run watchdog item"),
  action("inbox.read", "GET", "/api/companies/:companyId/(attention|attention/summary|attention/tasks|inbox/mine)", "Read the person's inbox"),
];

export function matchUserDelegateAction(method: string, path: string): UserDelegateActionDescriptor | null {
  const upper = method.toUpperCase();
  const match = USER_DELEGATE_ACTIONS.find((entry) => entry.method === upper && entry.pattern.test(path));
  return match ? { key: match.key, method: match.method, path: match.path, description: match.description } : null;
}

export function listUserDelegateActions(): UserDelegateActionDescriptor[] {
  return USER_DELEGATE_ACTIONS.map(({ key, method, path, description }) => ({ key, method, path, description }));
}

type UserDelegateRow = typeof userDelegates.$inferSelect;

function toUserDelegate(row: UserDelegateRow): UserDelegate {
  return {
    id: row.id,
    companyId: row.companyId,
    userId: row.userId,
    delegateAgentId: row.delegateAgentId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

export function userDelegateService(db: Db) {
  async function getActive(companyId: string, userId: string): Promise<UserDelegate | null> {
    const row = await db.select().from(userDelegates)
      .where(and(eq(userDelegates.companyId, companyId), eq(userDelegates.userId, userId), eq(userDelegates.status, "active")))
      .then((rows) => rows[0] ?? null);
    return row ? toUserDelegate(row) : null;
  }

  async function findActiveForAgent(companyId: string, userId: string, agentId: string): Promise<UserDelegate | null> {
    const row = await db.select().from(userDelegates)
      .where(and(
        eq(userDelegates.companyId, companyId),
        eq(userDelegates.userId, userId),
        eq(userDelegates.delegateAgentId, agentId),
        eq(userDelegates.status, "active"),
      ))
      .then((rows) => rows[0] ?? null);
    return row ? toUserDelegate(row) : null;
  }

  async function listActiveForAgent(companyId: string, agentId: string): Promise<UserDelegate[]> {
    const rows = await db.select().from(userDelegates)
      .where(and(eq(userDelegates.companyId, companyId), eq(userDelegates.delegateAgentId, agentId), eq(userDelegates.status, "active")));
    return rows.map(toUserDelegate);
  }

  async function getUserMembership(companyId: string, userId: string) {
    return db.select({ status: companyMemberships.status, membershipRole: companyMemberships.membershipRole })
      .from(companyMemberships)
      .where(and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
      ))
      .then((rows) => rows[0] ?? null);
  }

  /** Name `agentId` as the person's only delegate, replacing any earlier one. */
  async function set(companyId: string, userId: string, agentId: string) {
    const agent = await db.select({ id: agents.id, status: agents.status }).from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    if (agent.status === "terminated" || agent.status === "pending_approval") {
      throw unprocessable("This agent cannot be a delegate", { code: "user_delegate_agent_unavailable" });
    }
    try {
      return await db.transaction(async (tx) => {
        const now = new Date();
        const previous = await tx.update(userDelegates)
          .set({ status: "revoked", revokedAt: now, revokedByUserId: userId, updatedAt: now })
          .where(and(eq(userDelegates.companyId, companyId), eq(userDelegates.userId, userId), eq(userDelegates.status, "active")))
          .returning();
        const [created] = await tx.insert(userDelegates)
          .values({ companyId, userId, delegateAgentId: agentId, createdByUserId: userId })
          .returning();
        return { delegate: toUserDelegate(created!), previous: previous[0] ? toUserDelegate(previous[0]) : null };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("Your delegate changed at the same time; reload and try again");
      throw error;
    }
  }

  /** Turn the person's delegate off. Returns the revoked delegate, if any. */
  async function revoke(companyId: string, userId: string): Promise<UserDelegate | null> {
    const now = new Date();
    const rows = await db.update(userDelegates)
      .set({ status: "revoked", revokedAt: now, revokedByUserId: userId, updatedAt: now })
      .where(and(eq(userDelegates.companyId, companyId), eq(userDelegates.userId, userId), eq(userDelegates.status, "active")))
      .returning();
    return rows[0] ? toUserDelegate(rows[0]) : null;
  }

  return { getActive, findActiveForAgent, listActiveForAgent, getUserMembership, set, revoke };
}
