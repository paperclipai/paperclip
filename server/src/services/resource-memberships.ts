import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentMemberships,
  agents,
  projectMemberships,
  projects,
} from "@paperclipai/db";
import type {
  ResourceMembershipResourceType,
  ResourceMembershipState,
  ResourceMemberships,
  ResourceMembershipUpdateResult,
} from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";

type BoardActor = {
  type: "board" | "agent" | "none";
  userId?: string;
  companyIds?: string[];
  memberships?: Array<{
    companyId: string;
    membershipRole?: string | null;
    status?: string;
  }>;
  isInstanceAdmin?: boolean;
  source?: string;
};

type PolicyDecision = {
  allowed: boolean;
  reason?: string | null;
  source?: string | null;
};

export type ResourceMembershipPolicyHook = (input: {
  actor: BoardActor;
  companyId: string;
  userId: string;
  resourceType: ResourceMembershipResourceType;
  resourceId: string;
  state: ResourceMembershipState;
}) => Promise<PolicyDecision> | PolicyDecision;

type ResourceMembershipServiceOptions = {
  policyHook?: ResourceMembershipPolicyHook | null;
};

function defaultJoinedMap<T extends { projectId?: string; agentId?: string; state: string }>(
  rows: T[],
  key: "projectId" | "agentId",
): Record<string, ResourceMembershipState> {
  const result: Record<string, ResourceMembershipState> = {};
  for (const row of rows) {
    const id = row[key];
    if (typeof id !== "string") continue;
    result[id] = row.state === "left" ? "left" : "joined";
  }
  return result;
}

function latestDate(...dates: Array<Date | null | undefined>): Date | null {
  let latest: Date | null = null;
  for (const date of dates) {
    if (!date) continue;
    if (!latest || date.getTime() > latest.getTime()) latest = date;
  }
  return latest;
}

function assertBoardSelfMembershipAccess(actor: BoardActor, companyId: string, userId: string) {
  if (actor.type !== "board" || !actor.userId) {
    throw forbidden("Board user access required");
  }
  if (actor.userId !== userId) {
    throw forbidden("Users may only update their own resource memberships");
  }
  if (actor.source === "local_implicit" || actor.isInstanceAdmin) {
    return;
  }
  const membership = actor.memberships?.find((item) => item.companyId === companyId);
  if (!membership || membership.status !== "active") {
    throw forbidden("User does not have active company access");
  }
}

async function evaluatePolicy(
  hook: ResourceMembershipPolicyHook | null | undefined,
  input: Parameters<ResourceMembershipPolicyHook>[0],
): Promise<PolicyDecision> {
  if (!hook) return { allowed: true, source: "oss_default" };
  try {
    const decision = await hook(input);
    return {
      allowed: decision.allowed === true,
      reason: decision.reason ?? null,
      source: decision.source ?? "policy_hook",
    };
  } catch (err) {
    logger.warn(
      { err, companyId: input.companyId, resourceType: input.resourceType, resourceId: input.resourceId },
      "resource membership policy hook failed closed",
    );
    return { allowed: false, reason: "policy_hook_failed", source: "policy_hook" };
  }
}

export function resourceMembershipService(db: Db, options: ResourceMembershipServiceOptions = {}) {
  const policyHook = options.policyHook ?? null;

  async function assertMutationAllowed(input: {
    actor: BoardActor;
    companyId: string;
    userId: string;
    resourceType: ResourceMembershipResourceType;
    resourceId: string;
    state: ResourceMembershipState;
  }): Promise<PolicyDecision> {
    assertBoardSelfMembershipAccess(input.actor, input.companyId, input.userId);
    const decision = await evaluatePolicy(policyHook, input);
    if (!decision.allowed) {
      logger.warn(
        {
          companyId: input.companyId,
          userId: input.userId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          reason: decision.reason ?? "denied",
          source: decision.source ?? "policy_hook",
        },
        "resource membership mutation denied",
      );
      throw forbidden("Resource membership policy denied this request");
    }
    return decision;
  }

  return {
    async activeProjectIdsForUser(companyId: string, userId: string): Promise<string[]> {
      const rows = await db
        .select({
          projectId: projectMemberships.projectId,
          state: projectMemberships.state,
        })
        .from(projectMemberships)
        .where(and(
          eq(projectMemberships.companyId, companyId),
          eq(projectMemberships.userId, userId),
        ));
      return rows
        .filter((row) => row.state !== "left" && typeof row.projectId === "string")
        .map((row) => row.projectId);
    },

    async listForUser(companyId: string, userId: string, actor: BoardActor): Promise<ResourceMemberships> {
      assertBoardSelfMembershipAccess(actor, companyId, userId);
      const [projectRows, agentRows] = await Promise.all([
        db
          .select({
            projectId: projectMemberships.projectId,
            state: projectMemberships.state,
            updatedAt: projectMemberships.updatedAt,
          })
          .from(projectMemberships)
          .where(and(
            eq(projectMemberships.companyId, companyId),
            eq(projectMemberships.userId, userId),
          )),
        db
          .select({
            agentId: agentMemberships.agentId,
            state: agentMemberships.state,
            updatedAt: agentMemberships.updatedAt,
          })
          .from(agentMemberships)
          .where(and(
            eq(agentMemberships.companyId, companyId),
            eq(agentMemberships.userId, userId),
          )),
      ]);
      return {
        projectMemberships: defaultJoinedMap(projectRows, "projectId"),
        agentMemberships: defaultJoinedMap(agentRows, "agentId"),
        updatedAt: latestDate(
          ...projectRows.map((row) => row.updatedAt),
          ...agentRows.map((row) => row.updatedAt),
        ),
      };
    },

    async updateProject(input: {
      companyId: string;
      userId: string;
      projectId: string;
      state: ResourceMembershipState;
      actor: BoardActor;
    }): Promise<ResourceMembershipUpdateResult & { changed: boolean; policySource: string }> {
      const project = await db.query.projects.findFirst({
        where: and(
          eq(projects.id, input.projectId),
          eq(projects.companyId, input.companyId),
        ),
      });
      if (!project) throw notFound("Project not found");
      const decision = await assertMutationAllowed({
        actor: input.actor,
        companyId: input.companyId,
        userId: input.userId,
        resourceType: "project",
        resourceId: input.projectId,
        state: input.state,
      });

      const existing = await db.query.projectMemberships.findFirst({
        where: and(
          eq(projectMemberships.companyId, input.companyId),
          eq(projectMemberships.userId, input.userId),
          eq(projectMemberships.projectId, input.projectId),
        ),
      });
      const previousState: ResourceMembershipState = existing?.state === "left" ? "left" : "joined";
      if (previousState === input.state) {
        return {
          resourceType: "project",
          resourceId: input.projectId,
          state: input.state,
          updatedAt: existing?.updatedAt ?? new Date(),
          changed: false,
          policySource: decision.source ?? "oss_default",
        };
      }

      const now = new Date();
      const [row] = await db
        .insert(projectMemberships)
        .values({
          companyId: input.companyId,
          projectId: input.projectId,
          userId: input.userId,
          state: input.state,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [projectMemberships.companyId, projectMemberships.userId, projectMemberships.projectId],
          set: {
            state: input.state,
            updatedAt: now,
          },
        })
        .returning();

      return {
        resourceType: "project",
        resourceId: input.projectId,
        state: row?.state === "left" ? "left" : "joined",
        updatedAt: row?.updatedAt ?? now,
        changed: true,
        policySource: decision.source ?? "oss_default",
      };
    },

    async updateAgent(input: {
      companyId: string;
      userId: string;
      agentId: string;
      state: ResourceMembershipState;
      actor: BoardActor;
    }): Promise<ResourceMembershipUpdateResult & { changed: boolean; policySource: string }> {
      const agent = await db.query.agents.findFirst({
        where: and(
          eq(agents.id, input.agentId),
          eq(agents.companyId, input.companyId),
        ),
      });
      if (!agent) throw notFound("Agent not found");
      const decision = await assertMutationAllowed({
        actor: input.actor,
        companyId: input.companyId,
        userId: input.userId,
        resourceType: "agent",
        resourceId: input.agentId,
        state: input.state,
      });

      const existing = await db.query.agentMemberships.findFirst({
        where: and(
          eq(agentMemberships.companyId, input.companyId),
          eq(agentMemberships.userId, input.userId),
          eq(agentMemberships.agentId, input.agentId),
        ),
      });
      const previousState: ResourceMembershipState = existing?.state === "left" ? "left" : "joined";
      if (previousState === input.state) {
        return {
          resourceType: "agent",
          resourceId: input.agentId,
          state: input.state,
          updatedAt: existing?.updatedAt ?? new Date(),
          changed: false,
          policySource: decision.source ?? "oss_default",
        };
      }

      const now = new Date();
      const [row] = await db
        .insert(agentMemberships)
        .values({
          companyId: input.companyId,
          agentId: input.agentId,
          userId: input.userId,
          state: input.state,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [agentMemberships.companyId, agentMemberships.userId, agentMemberships.agentId],
          set: {
            state: input.state,
            updatedAt: now,
          },
        })
        .returning();

      return {
        resourceType: "agent",
        resourceId: input.agentId,
        state: row?.state === "left" ? "left" : "joined",
        updatedAt: row?.updatedAt ?? now,
        changed: true,
        policySource: decision.source ?? "oss_default",
      };
    },
  };
}
