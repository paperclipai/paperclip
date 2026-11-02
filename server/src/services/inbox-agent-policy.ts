import { and, eq, inArray } from "drizzle-orm";
import { agents, userInboxAgentPolicies, type Db } from "@paperclipai/db";
import type { InboxAgentPolicy, UpdateInboxAgentPolicy } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

export function inboxAgentPolicyService(db: Db) {
  async function get(companyId: string, userId: string): Promise<InboxAgentPolicy> {
    const row = await db
      .select()
      .from(userInboxAgentPolicies)
      .where(and(
        eq(userInboxAgentPolicies.companyId, companyId),
        eq(userInboxAgentPolicies.userId, userId),
      ))
      .then((rows) => rows[0] ?? null);
    return row
      ? { ...row, materialized: true }
      : {
          companyId,
          userId,
          mode: "open",
          allowedAgentIds: [],
          materialized: false,
          createdAt: null,
          updatedAt: null,
        };
  }

  async function update(companyId: string, userId: string, input: UpdateInboxAgentPolicy): Promise<InboxAgentPolicy> {
    const allowedAgentIds = input.mode === "allowlist" ? [...new Set(input.allowedAgentIds)] : [];
    if (allowedAgentIds.length > 0) {
      const companyAgentIds = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, allowedAgentIds)))
        .then((rows) => new Set(rows.map((row) => row.id)));
      const invalidAgentIds = allowedAgentIds.filter((agentId) => !companyAgentIds.has(agentId));
      if (invalidAgentIds.length > 0) {
        throw unprocessable("Inbox agent policy contains agents outside the company", {
          code: "inbox_agent_policy_invalid_agents",
          invalidAgentIds,
        });
      }
    }
    const now = new Date();
    const [row] = await db
      .insert(userInboxAgentPolicies)
      .values({ companyId, userId, mode: input.mode, allowedAgentIds, updatedAt: now })
      .onConflictDoUpdate({
        target: [userInboxAgentPolicies.companyId, userInboxAgentPolicies.userId],
        set: { mode: input.mode, allowedAgentIds, updatedAt: now },
      })
      .returning();
    return { ...row!, materialized: true };
  }

  return { get, update };
}
