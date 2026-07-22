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
  starred?: boolean;
}) => Promise<PolicyDecision> | PolicyDecision;

type ResourceMembershipServiceOptions = {
  policyHook?: ResourceMembershipPolicyHook | null;
};

type MembershipChangeKind = ResourceMembershipState | "starred" | "unstarred";

type MembershipUpdateResult = ResourceMembershipUpdateResult & {
  changed: boolean;
  changeKind: MembershipChangeKind | null;
  policySource: string;
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

function starredAtMap<T extends { projectId?: string; agentId?: string; starredAt: Date | null }>(
  rows: T[],
  key: "projectId" | "agentId",
): Record<string, Date> {
  const result: Record<string, Date> = {};
  for (const row of rows) {
    const id = row[key];
    if (typeof id !== "string" || !row.starredAt) continue;
    result[id] = row.starredAt;
  }
  return result;
}

function starredIds<T extends { projectId?: string; agentId?: string; starredAt: Date | null }>(
  rows: T[],
  key: "projectId" | "agentId",
): string[] {
  return rows
    .filter((row) => row.starredAt)
    .sort((a, b) => b.starredAt!.getTime() - a.starredAt!.getTime())
    .map((row) => row[key])
    .filter((id): id is string => typeof id === "string");
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
    starred?: boolean;
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
    async listForUser(companyId: string, userId: string, actor: BoardActor): Promise<ResourceMemberships> {
      assertBoardSelfMembershipAccess(actor, companyId, userId);
      const [projectRows, agentRows] = await Promise.all([
        db
          .select({
            projectId: projectMemberships.projectId,
            state: projectMemberships.state,
            starredAt: projectMemberships.starredAt,
            updatedAt: projectMemberships.updatedAt,
            projectArchivedAt: projects.archivedAt,
          })
          .from(projectMemberships)
          .innerJoin(projects, and(
            eq(projects.id, projectMemberships.projectId),
            eq(projects.companyId, projectMemberships.companyId),
          ))
          .where(and(
            eq(projectMemberships.companyId, companyId),
            eq(projectMemberships.userId, userId),
          )),
        db
          .select({
            agentId: agentMemberships.agentId,
            state: agentMemberships.state,
            starredAt: agentMemberships.starredAt,
            updatedAt: agentMemberships.updatedAt,
            agentStatus: agents.status,
          })
          .from(agentMemberships)
          .innerJoin(agents, and(
            eq(agents.id, agentMemberships.agentId),
            eq(agents.companyId, agentMemberships.companyId),
          ))
          .where(and(
            eq(agentMemberships.companyId, companyId),
            eq(agentMemberships.userId, userId),
          )),
      ]);
      const starEligibleProjectRows = projectRows.filter((row) => row.starredAt && !row.projectArchivedAt);
      const starEligibleAgentRows = agentRows.filter((row) => row.starredAt && row.agentStatus !== "terminated");
      return {
        projectMemberships: defaultJoinedMap(projectRows, "projectId"),
        agentMemberships: defaultJoinedMap(agentRows, "agentId"),
        starredProjectIds: starredIds(starEligibleProjectRows, "projectId"),
        starredAgentIds: starredIds(starEligibleAgentRows, "agentId"),
        projectStarredAt: starredAtMap(starEligibleProjectRows, "projectId"),
        agentStarredAt: starredAtMap(starEligibleAgentRows, "agentId"),
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
      state?: ResourceMembershipState;
      starred?: boolean;
      actor: BoardActor;
    }): Promise<MembershipUpdateResult> {
      const project = await db.query.projects.findFirst({
        where: and(
          eq(projects.id, input.projectId),
          eq(projects.companyId, input.companyId),
        ),
      });
      if (!project || project.archivedAt) throw notFound("Project not found");

      const existing = await db.query.projectMemberships.findFirst({
        where: and(
          eq(projectMemberships.companyId, input.companyId),
          eq(projectMemberships.userId, input.userId),
          eq(projectMemberships.projectId, input.projectId),
        ),
      });
      const previousState: ResourceMembershipState = existing?.state === "left" ? "left" : "joined";
      const previousStarredAt = existing?.starredAt ?? null;
      const nextState: ResourceMembershipState = input.starred === true ? "joined" : input.state ?? previousState;
      const nextStarredAt = nextState === "left"
        ? null
        : input.starred === true
          ? previousStarredAt ?? new Date()
          : input.starred === false
            ? null
            : previousStarredAt;
      const stateChanged = previousState !== nextState;
      const starredChanged = (previousStarredAt?.getTime() ?? null) !== (nextStarredAt?.getTime() ?? null);
      const decision = await assertMutationAllowed({
        actor: input.actor,
        companyId: input.companyId,
        userId: input.userId,
        resourceType: "project",
        resourceId: input.projectId,
        state: nextState,
        starred: input.starred,
      });

      if (!stateChanged && !starredChanged) {
        return {
          resourceType: "project",
          resourceId: input.projectId,
          state: nextState,
          starredAt: previousStarredAt,
          updatedAt: existing?.updatedAt ?? new Date(),
          changed: false,
          changeKind: null,
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
          state: nextState,
          starredAt: nextStarredAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [projectMemberships.companyId, projectMemberships.userId, projectMemberships.projectId],
          set: {
            state: nextState,
            starredAt: nextStarredAt,
            updatedAt: now,
          },
        })
        .returning();

      return {
        resourceType: "project",
        resourceId: input.projectId,
        state: row?.state === "left" ? "left" : "joined",
        starredAt: row?.starredAt ?? null,
        updatedAt: row?.updatedAt ?? now,
        changed: true,
        changeKind: input.starred !== undefined && starredChanged
          ? input.starred ? "starred" : "unstarred"
          : stateChanged ? nextState : nextStarredAt ? "starred" : "unstarred",
        policySource: decision.source ?? "oss_default",
      };
    },

    async updateAgent(input: {
      companyId: string;
      userId: string;
      agentId: string;
      state?: ResourceMembershipState;
      starred?: boolean;
      actor: BoardActor;
    }): Promise<MembershipUpdateResult> {
      const agent = await db.query.agents.findFirst({
        where: and(
          eq(agents.id, input.agentId),
          eq(agents.companyId, input.companyId),
        ),
      });
      if (!agent || agent.status === "terminated") throw notFound("Agent not found");

      const existing = await db.query.agentMemberships.findFirst({
        where: and(
          eq(agentMemberships.companyId, input.companyId),
          eq(agentMemberships.userId, input.userId),
          eq(agentMemberships.agentId, input.agentId),
        ),
      });
      const previousState: ResourceMembershipState = existing?.state === "left" ? "left" : "joined";
      const previousStarredAt = existing?.starredAt ?? null;
      const nextState: ResourceMembershipState = input.starred === true ? "joined" : input.state ?? previousState;
      const nextStarredAt = nextState === "left"
        ? null
        : input.starred === true
          ? previousStarredAt ?? new Date()
          : input.starred === false
            ? null
            : previousStarredAt;
      const stateChanged = previousState !== nextState;
      const starredChanged = (previousStarredAt?.getTime() ?? null) !== (nextStarredAt?.getTime() ?? null);
      const decision = await assertMutationAllowed({
        actor: input.actor,
        companyId: input.companyId,
        userId: input.userId,
        resourceType: "agent",
        resourceId: input.agentId,
        state: nextState,
        starred: input.starred,
      });

      if (!stateChanged && !starredChanged) {
        return {
          resourceType: "agent",
          resourceId: input.agentId,
          state: nextState,
          starredAt: previousStarredAt,
          updatedAt: existing?.updatedAt ?? new Date(),
          changed: false,
          changeKind: null,
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
          state: nextState,
          starredAt: nextStarredAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [agentMemberships.companyId, agentMemberships.userId, agentMemberships.agentId],
          set: {
            state: nextState,
            starredAt: nextStarredAt,
            updatedAt: now,
          },
        })
        .returning();

      return {
        resourceType: "agent",
        resourceId: input.agentId,
        state: row?.state === "left" ? "left" : "joined",
        starredAt: row?.starredAt ?? null,
        updatedAt: row?.updatedAt ?? now,
        changed: true,
        changeKind: input.starred !== undefined && starredChanged
          ? input.starred ? "starred" : "unstarred"
          : stateChanged ? nextState : nextStarredAt ? "starred" : "unstarred",
        policySource: decision.source ?? "oss_default",
      };
    },
  };
}
