import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { CAPABILITY_APPLY_ERROR_CODES } from "@paperclipai/shared";
import { badRequest, forbidden, notFound, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { capabilityApplyService } from "../services/capability-apply.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

const createPlanSchema = z.object({
  effectiveDelta: z.object({
    mcpServerChanges: z
      .array(
        z.object({
          kind: z.enum(["add", "remove", "update"]),
          serverId: z.string().min(1).max(240),
          displayName: z.string().min(1).max(240),
          catalogId: z.string().max(240).optional(),
          transport: z.string().optional(),
          riskClass: z.string().optional(),
          changedFields: z.array(z.string()).optional(),
          requiredSecretNames: z.array(z.string()).optional(),
          readOnlyHint: z.boolean().optional(),
          destructiveHint: z.boolean().optional(),
          openWorldHint: z.boolean().optional(),
        }),
      )
      .optional(),
    skillRefChanges: z
      .array(z.object({ kind: z.enum(["add", "remove"]), ref: z.string().min(1).max(240) }))
      .optional(),
    toolRefChanges: z
      .array(z.object({ kind: z.enum(["add", "remove"]), ref: z.string().min(1).max(240) }))
      .optional(),
  }),
  proposalIdentity: z.string().min(1).max(240).optional(),
});

function parseIfMatchVersion(req: Parameters<typeof getActorInfo>[0]): number {
  const raw = (req.headers as Record<string, string | undefined>)["if-match"];
  if (!raw) throw badRequest("If-Match header is required for mutating operations");
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) throw badRequest("If-Match must be a positive integer (optimistic_version)");
  return parsed;
}

async function resolveAgentCompany(db: Db, agentId: string): Promise<string> {
  const [row] = await db
    .select({ companyId: agents.companyId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!row) throw notFound("Agent not found");
  return row.companyId;
}

export function capabilityApplyRoutes(db: Db, opts: { capabilityApplyLive: boolean }) {
  const router = Router();
  const svc = capabilityApplyService(db, opts);

  // POST /companies/:companyId/agents/:agentId/capability-apply/plans
  router.post(
    "/companies/:companyId/agents/:agentId/capability-apply/plans",
    validate(createPlanSchema),
    async (req, res) => {
      const { companyId, agentId } = req.params as { companyId: string; agentId: string };
      assertCompanyAccess(req, companyId);

      const agentCompanyId = await resolveAgentCompany(db, agentId);
      if (agentCompanyId !== companyId) throw forbidden("Agent does not belong to this company");

      const actor = getActorInfo(req);
      const plan = await svc.createPlan(
        {
          companyId,
          agentId,
          effectiveDelta: req.body.effectiveDelta,
          proposalIdentity: req.body.proposalIdentity,
        },
        {
          userId: actor.actorType === "user" ? actor.actorId : undefined,
          agentId: actor.agentId ?? undefined,
          runId: actor.runId ?? undefined,
        },
      );

      res.status(201).json(plan);
    },
  );

  // GET /companies/:companyId/agents/:agentId/capability-apply/plans/:planId
  router.get(
    "/companies/:companyId/agents/:agentId/capability-apply/plans/:planId",
    async (req, res) => {
      const { companyId, planId } = req.params as { companyId: string; agentId: string; planId: string };
      assertCompanyAccess(req, companyId);
      const plan = await svc.getPlan(planId, companyId);
      res.json(plan);
    },
  );

  // POST /companies/:companyId/agents/:agentId/capability-apply/plans/:planId/request-approval
  router.post(
    "/companies/:companyId/agents/:agentId/capability-apply/plans/:planId/request-approval",
    async (req, res) => {
      const { companyId, agentId, planId } = req.params as {
        companyId: string;
        agentId: string;
        planId: string;
      };
      assertCompanyAccess(req, companyId);

      const ifMatch = parseIfMatchVersion(req);
      const actor = getActorInfo(req);

      // Server-builds the approval payload — never trust client body for approval payload
      const result = await svc.requestApproval(
        planId,
        companyId,
        agentId,
        {
          userId: actor.actorType === "user" ? actor.actorId : undefined,
          agentId: actor.agentId ?? undefined,
          runId: actor.runId ?? undefined,
        },
        ifMatch,
      );

      res.json(result);
    },
  );

  // POST /companies/:companyId/agents/:agentId/capability-apply/plans/:planId/cancel
  router.post(
    "/companies/:companyId/agents/:agentId/capability-apply/plans/:planId/cancel",
    async (req, res) => {
      const { companyId, planId } = req.params as { companyId: string; agentId: string; planId: string };
      assertCompanyAccess(req, companyId);

      const ifMatch = parseIfMatchVersion(req);
      const actor = getActorInfo(req);

      const plan = await svc.cancelPlan(
        planId,
        companyId,
        {
          userId: actor.actorType === "user" ? actor.actorId : undefined,
          agentId: actor.agentId ?? undefined,
          runId: actor.runId ?? undefined,
        },
        ifMatch,
      );

      res.json(plan);
    },
  );

  // GET /companies/:companyId/agents/:agentId/capability-apply/plans/:planId/events
  router.get(
    "/companies/:companyId/agents/:agentId/capability-apply/plans/:planId/events",
    async (req, res) => {
      const { companyId, planId } = req.params as { companyId: string; agentId: string; planId: string };
      assertCompanyAccess(req, companyId);
      const events = await svc.getPlanEvents(planId, companyId);
      res.json(events);
    },
  );

  return router;
}
