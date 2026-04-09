import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, projects, routines, routineTriggers } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { goalService } from "./goals.js";
import { projectService } from "./projects.js";
import { routineService } from "./routines.js";

const EXECUTIVE_REVIEW_PROJECT_NAME = "Executive Reviews";
const EXECUTIVE_REVIEW_PROJECT_DESCRIPTION =
  "Recurring executive cadences for company-wide progress reviews and follow-up.";
const EXECUTIVE_REVIEW_ROUTINE_TITLE = "Weekly Company Review";
const EXECUTIVE_REVIEW_ROUTINE_DESCRIPTION = [
  "Run the Monday executive company review.",
  "",
  "Review every active project and capture:",
  "- progress since the previous weekly review",
  "- next planned milestone and any missing owner",
  "- research work that is active, blocked, or still missing",
  "- stale tasks, blockers, budget pressure, and risks that need escalation",
  "",
  "Create or delegate follow-up issues when work needs attention, then complete the execution issue.",
].join("\n");
const EXECUTIVE_REVIEW_TRIGGER_LABEL = "Monday morning";
const EXECUTIVE_REVIEW_CRON_EXPRESSION = "0 9 * * 1";
const DEFAULT_COMPANY_TIMEZONE = "UTC";
const SYSTEM_ACTIVITY_ACTOR_ID = "default_agent_routines";

type ActivityActor = {
  actorType?: "user" | "agent" | "system";
  actorId?: string | null;
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

type AgentLike = {
  id: string;
  companyId: string;
  name: string;
  role: string;
  title: string | null;
  status: string;
};

function shouldProvisionDefaultRoutine(agent: AgentLike) {
  if (agent.status === "pending_approval" || agent.status === "terminated") return false;
  return agent.role === "ceo";
}

function toRoutineActor(actor: ActivityActor) {
  return {
    agentId: actor.agentId ?? null,
    userId: actor.userId ?? null,
  };
}

function toActivityActor(actor: ActivityActor) {
  return {
    actorType: actor.actorType ?? "system",
    actorId: actor.actorId ?? SYSTEM_ACTIVITY_ACTOR_ID,
    agentId: actor.agentId ?? null,
    runId: actor.runId ?? null,
  } as const;
}

export async function ensureDefaultRoutinesForAgent(
  db: Db,
  input: { agent: AgentLike; actor?: ActivityActor },
): Promise<void> {
  const { agent } = input;
  if (!shouldProvisionDefaultRoutine(agent)) return;

  const actor = input.actor ?? {};
  const activityActor = toActivityActor(actor);
  const goals = goalService(db);
  const projectsSvc = projectService(db);
  const routinesSvc = routineService(db);
  const company = await db
    .select({ timezone: companies.timezone })
    .from(companies)
    .where(eq(companies.id, agent.companyId))
    .then((rows) => rows[0] ?? null);
  const triggerTimezone = company?.timezone?.trim() || DEFAULT_COMPANY_TIMEZONE;

  const defaultGoal = await goals.getDefaultCompanyGoal(agent.companyId);

  const existingProject = await db
    .select()
    .from(projects)
    .where(and(eq(projects.companyId, agent.companyId), eq(projects.name, EXECUTIVE_REVIEW_PROJECT_NAME)))
    .orderBy(asc(projects.createdAt), asc(projects.id))
    .then((rows) => rows[0] ?? null);
  let projectId = existingProject?.id ?? null;

  if (!projectId) {
    const createdProject = await projectsSvc.create(agent.companyId, {
      name: EXECUTIVE_REVIEW_PROJECT_NAME,
      description: EXECUTIVE_REVIEW_PROJECT_DESCRIPTION,
      status: "in_progress",
      leadAgentId: agent.id,
      ...(defaultGoal ? { goalIds: [defaultGoal.id] } : {}),
    });
    projectId = createdProject.id;

    await logActivity(db, {
      companyId: agent.companyId,
      ...activityActor,
      action: "project.created",
      entityType: "project",
      entityId: createdProject.id,
      details: {
        name: createdProject.name,
        source: "default_agent_routines",
      },
    });
  }

  let routine = await db
    .select()
    .from(routines)
    .where(
      and(
        eq(routines.companyId, agent.companyId),
        eq(routines.assigneeAgentId, agent.id),
        eq(routines.title, EXECUTIVE_REVIEW_ROUTINE_TITLE),
      ),
    )
    .orderBy(asc(routines.createdAt), asc(routines.id))
    .then((rows) => rows[0] ?? null);

  if (!routine) {
    routine = await routinesSvc.create(
      agent.companyId,
      {
        projectId: projectId!,
        goalId: defaultGoal?.id ?? null,
        title: EXECUTIVE_REVIEW_ROUTINE_TITLE,
        description: EXECUTIVE_REVIEW_ROUTINE_DESCRIPTION,
        assigneeAgentId: agent.id,
        priority: "high",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
      },
      toRoutineActor(actor),
    );

    await logActivity(db, {
      companyId: agent.companyId,
      ...activityActor,
      action: "routine.created",
      entityType: "routine",
      entityId: routine.id,
      details: {
        title: routine.title,
        assigneeAgentId: routine.assigneeAgentId,
        source: "default_agent_routines",
      },
    });
  }

  const existingScheduleTrigger = await db
    .select()
    .from(routineTriggers)
    .where(and(eq(routineTriggers.routineId, routine.id), eq(routineTriggers.kind, "schedule")))
    .orderBy(asc(routineTriggers.createdAt), asc(routineTriggers.id))
    .then((rows) => rows[0] ?? null);

  if (existingScheduleTrigger) return;

  const createdTrigger = await routinesSvc.createTrigger(
    routine.id,
    {
      kind: "schedule",
      label: EXECUTIVE_REVIEW_TRIGGER_LABEL,
      enabled: true,
      cronExpression: EXECUTIVE_REVIEW_CRON_EXPRESSION,
      timezone: triggerTimezone,
    },
    toRoutineActor(actor),
  );

  await logActivity(db, {
    companyId: agent.companyId,
    ...activityActor,
    action: "routine.trigger_created",
    entityType: "routine_trigger",
    entityId: createdTrigger.trigger.id,
    details: {
      routineId: routine.id,
      kind: createdTrigger.trigger.kind,
      source: "default_agent_routines",
    },
  });
}

export async function ensureDefaultRoutinesForAgentBestEffort(
  db: Db,
  input: { agent: AgentLike; actor?: ActivityActor },
): Promise<void> {
  try {
    await ensureDefaultRoutinesForAgent(db, input);
  } catch (err) {
    logger.error(
      {
        err,
        companyId: input.agent.companyId,
        agentId: input.agent.id,
        role: input.agent.role,
      },
      "default agent routine bootstrap failed",
    );
  }
}

export async function reconcileDefaultAgentRoutines(
  db: Db,
  input: {
    companyId?: string;
    actor?: ActivityActor;
  } = {},
): Promise<{ reconciled: number; failed: number; failedAgentIds: string[] }> {
  const conditions = [
    inArray(agents.status, ["active", "idle", "paused", "running", "error"]),
  ];
  if (input.companyId) {
    conditions.push(eq(agents.companyId, input.companyId));
  }
  const rows = await db
    .select()
    .from(agents)
    .where(and(...conditions));

  const actor = input.actor ?? {
    actorType: "system",
    actorId: SYSTEM_ACTIVITY_ACTOR_ID,
  };
  let reconciled = 0;
  let failed = 0;
  const failedAgentIds: string[] = [];
  for (const agent of rows) {
    if (agent.role !== "ceo") continue;
    const normalizedAgent = {
      id: agent.id,
      companyId: agent.companyId,
      name: agent.name,
      role: agent.role,
      title: agent.title,
      status: agent.status,
    };
    try {
      await ensureDefaultRoutinesForAgent(db, {
        agent: normalizedAgent,
        actor,
      });
      reconciled += 1;
    } catch (err) {
      failed += 1;
      failedAgentIds.push(agent.id);
      logger.error(
        {
          err,
          companyId: agent.companyId,
          agentId: agent.id,
          role: agent.role,
        },
        "default agent routine reconciliation failed",
      );
    }
  }

  return { reconciled, failed, failedAgentIds };
}

export async function reconcileDefaultAgentRoutinesOnStartup(db: Db): Promise<{ reconciled: number }> {
  const result = await reconcileDefaultAgentRoutines(db, {
    actor: {
      actorType: "system",
      actorId: SYSTEM_ACTIVITY_ACTOR_ID,
    },
  });
  return { reconciled: result.reconciled };
}
