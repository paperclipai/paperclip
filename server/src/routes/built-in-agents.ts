import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { builtInAgentEmptyMutationSchema, builtInAgentProvisionSchema, builtInAgentResetSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { forbidden, notFound } from "../errors.js";
import { accessService, instanceSettingsService, logActivity } from "../services/index.js";
import { builtInAgentService } from "../services/built-in-agents.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import type { BuiltInAgentState } from "../services/built-in-agents.js";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatScheduleLabel(trigger: { cronExpression: string; timezone: string } | undefined) {
  if (!trigger) return "Weekly schedule";
  const parts = trigger.cronExpression.trim().split(/\s+/);
  const [minute, hour, , , dayOfWeek] = parts;
  const weekdayIndex = dayOfWeek ? Number(dayOfWeek) : Number.NaN;
  if (
    parts.length === 5
    && /^\d+$/.test(minute ?? "")
    && /^\d+$/.test(hour ?? "")
    && Number.isInteger(weekdayIndex)
    && weekdayIndex >= 0
    && weekdayIndex < WEEKDAY_LABELS.length
  ) {
    return `Weekly · ${WEEKDAY_LABELS[weekdayIndex]} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${trigger.timezone}`;
  }
  return `Weekly · ${trigger.timezone}`;
}

function redactBuiltInAgentListState(state: BuiltInAgentState): BuiltInAgentState {
  const definition = {
    ...state.definition,
    defaultInstructions: state.definition.defaultInstructions ? "[file-backed]" : "",
    bundle: state.definition.bundle
      ? {
        stockVersion: state.definition.bundle.stockVersion,
        instructions: {
          entryFile: state.definition.bundle.instructions.entryFile,
          files: Object.keys(state.definition.bundle.instructions.files),
        },
        skill: {
          skillKey: state.definition.bundle.skill.skillKey,
          displayName: state.definition.bundle.skill.displayName,
          slug: state.definition.bundle.skill.slug,
          canonicalKey: state.definition.bundle.skill.canonicalKey,
          files: Object.keys(state.definition.bundle.skill.files),
        },
        routine: {
          routineKey: state.definition.bundle.routine.routineKey,
          title: state.definition.bundle.routine.title,
          status: state.definition.bundle.routine.status,
          triggerCount: state.definition.bundle.routine.triggers.length,
          scheduleLabel: formatScheduleLabel(state.definition.bundle.routine.triggers[0]),
        },
      }
      : undefined,
  } as BuiltInAgentState["definition"];
  if (!state.agent) return { ...state, definition };
  return {
    ...state,
    definition,
    agent: {
      ...state.agent,
      adapterConfig: {},
      runtimeConfig: {},
    },
  };
}

export function builtInAgentRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const svc = builtInAgentService(db);
  const settings = instanceSettingsService(db);

  async function assertBuiltInAgentsEnabled() {
    const experimental = await settings.getExperimental();
    if (experimental.enableBuiltInAgents !== true) {
      throw notFound("Built-in agents are not enabled");
    }
  }

  async function assertCanProvisionBuiltInAgents(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "agents:create",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return;
    throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }

  async function assertCanControlBuiltInRoutine(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") {
      throw forbidden("Only board operators can control built-in routines.");
    }
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const allowed = await access.canUser(companyId, req.actor.userId, "tasks:assign");
    if (!allowed) {
      throw forbidden("Missing permission: tasks:assign");
    }
  }

  async function logBuiltInAgentMutation(
    req: Request,
      input: {
        companyId: string;
      action:
        | "built_in_agent.provision_requested"
        | "built_in_agent.reconcile"
        | "built_in_agent.reset"
        | "built_in_agent.routine_schedule_enabled"
        | "built_in_agent.routine_schedule_disabled"
        | "built_in_agent.routine_run_triggered"
        | "approval.created";
      key: string;
      agentId: string | null;
      status: string;
      approvalId?: string | null;
      routineKey?: string | null;
      routineRunId?: string | null;
    },
  ) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: input.action,
      entityType: input.action === "approval.created" ? "approval" : "agent",
      entityId: input.action === "approval.created" ? input.approvalId ?? input.key : input.agentId ?? input.key,
      ...(actor.agentId ? { agentId: actor.agentId } : {}),
      ...(actor.runId ? { runId: actor.runId } : {}),
      details: {
        key: input.key,
        status: input.status,
        approvalId: input.approvalId ?? null,
        routineKey: input.routineKey ?? null,
        routineRunId: input.routineRunId ?? null,
      },
    });
  }

  router.get("/companies/:companyId/built-in-agents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertBuiltInAgentsEnabled();
    const states = await svc.list(companyId);
    res.json(states.map(redactBuiltInAgentListState));
  });

  router.get("/companies/:companyId/built-in-agents/:key/status", async (req, res) => {
    const companyId = req.params.companyId as string;
    const key = req.params.key as string;
    assertCompanyAccess(req, companyId);
    await assertBuiltInAgentsEnabled();
    res.json(redactBuiltInAgentListState(await svc.get(companyId, key)));
  });

  router.post("/companies/:companyId/built-in-agents/:key/reconcile", validate(builtInAgentEmptyMutationSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const key = req.params.key as string;
    await assertBuiltInAgentsEnabled();
    await assertCanProvisionBuiltInAgents(req, companyId);
    const state = await svc.ensure(companyId, key);
    await logBuiltInAgentMutation(req, {
      companyId,
      action: "built_in_agent.reconcile",
      key,
      agentId: state.agentId,
      status: state.status,
    });
    res.json(redactBuiltInAgentListState(state));
  });

  router.post(
    "/companies/:companyId/built-in-agents/:key/provision",
    validate(builtInAgentProvisionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const key = req.params.key as string;
      await assertBuiltInAgentsEnabled();
      await assertCanProvisionBuiltInAgents(req, companyId);
      const actor = getActorInfo(req);
      const result = await svc.provision(companyId, key, req.body, {
        requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      const { state, approval } = result;
      await logBuiltInAgentMutation(req, {
        companyId,
        action: "built_in_agent.provision_requested",
        key,
        agentId: state.agentId,
        status: state.status,
      });
      if (approval) {
        await logBuiltInAgentMutation(req, {
          companyId,
          action: "approval.created",
          key,
          agentId: state.agentId,
          status: approval.status,
          approvalId: approval.id,
        });
      }
      res.status(approval ? 202 : 200).json(redactBuiltInAgentListState({ ...state, approval }));
    },
  );

  router.post("/companies/:companyId/built-in-agents/:key/reset", validate(builtInAgentResetSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const key = req.params.key as string;
    await assertBuiltInAgentsEnabled();
    await assertCanProvisionBuiltInAgents(req, companyId);
    const state = await svc.reset(companyId, key, req.body);
    await logBuiltInAgentMutation(req, {
      companyId,
      action: "built_in_agent.reset",
      key,
      agentId: state.agentId,
      status: state.status,
    });
    res.json(redactBuiltInAgentListState(state));
  });

  router.post(
    "/companies/:companyId/built-in-agents/:key/routines/:routineKey/enable",
    validate(builtInAgentEmptyMutationSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const key = req.params.key as string;
      const routineKey = req.params.routineKey as string;
      await assertBuiltInAgentsEnabled();
      assertCompanyAccess(req, companyId);
      await assertCanControlBuiltInRoutine(req, companyId);
      const actor = getActorInfo(req);
      const state = await svc.enableRoutineSchedule(companyId, key, routineKey, {
        agentId: actor.actorType === "agent" ? actor.actorId : null,
        userId: actor.actorType === "user" ? actor.actorId : null,
        runId: actor.runId ?? null,
      });
      await logBuiltInAgentMutation(req, {
        companyId,
        action: "built_in_agent.routine_schedule_enabled",
        key,
        agentId: state.agentId,
        status: state.status,
        routineKey,
      });
      res.json(redactBuiltInAgentListState(state));
    },
  );

  router.post(
    "/companies/:companyId/built-in-agents/:key/routines/:routineKey/disable",
    validate(builtInAgentEmptyMutationSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const key = req.params.key as string;
      const routineKey = req.params.routineKey as string;
      await assertBuiltInAgentsEnabled();
      assertCompanyAccess(req, companyId);
      await assertCanControlBuiltInRoutine(req, companyId);
      const actor = getActorInfo(req);
      const state = await svc.disableRoutineSchedule(companyId, key, routineKey, {
        agentId: actor.actorType === "agent" ? actor.actorId : null,
        userId: actor.actorType === "user" ? actor.actorId : null,
        runId: actor.runId ?? null,
      });
      await logBuiltInAgentMutation(req, {
        companyId,
        action: "built_in_agent.routine_schedule_disabled",
        key,
        agentId: state.agentId,
        status: state.status,
        routineKey,
      });
      res.json(redactBuiltInAgentListState(state));
    },
  );

  router.post(
    "/companies/:companyId/built-in-agents/:key/routines/:routineKey/run",
    validate(builtInAgentEmptyMutationSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const key = req.params.key as string;
      const routineKey = req.params.routineKey as string;
      await assertBuiltInAgentsEnabled();
      assertCompanyAccess(req, companyId);
      const current = await svc.get(companyId, key);
      await assertCanControlBuiltInRoutine(req, companyId);
      const actor = getActorInfo(req);
      const run = await svc.runRoutine(companyId, key, routineKey, {
        agentId: actor.actorType === "agent" ? actor.actorId : null,
        userId: actor.actorType === "user" ? actor.actorId : null,
        runId: actor.runId ?? null,
      });
      await logBuiltInAgentMutation(req, {
        companyId,
        action: "built_in_agent.routine_run_triggered",
        key,
        agentId: current.agentId,
        status: current.status,
        routineKey,
        routineRunId: run.id,
      });
      res.status(202).json(run);
    },
  );

  return router;
}
