/**
 * Recruiting routes — Phase 5.2e.
 *
 * "Recruiting" is the COS v2 workflow for proposing new agents via an
 * approval-gated pipeline. A human (or, in a future phase, another
 * agent) calls `POST /companies/:cid/recruiting/propose` with a
 * candidate spec (name, role, title, capabilities, adapterType). We
 * then:
 *
 *   1. Insert a new row in `agents` with status = "pending_approval".
 *   2. Create an `approvals` row of type "hire_agent" whose payload
 *      references that agent id.
 *
 * When a board user approves the approval (existing POST
 * /approvals/:id/approve endpoint), the existing hire-hook promotes
 * the agent to `status="idle"` via `agentsSvc.activatePendingApproval`.
 * Rejection terminates the agent.
 *
 * This route is intentionally tiny — all the heavy lifting (activation,
 * budget policy, notification) already exists in `approvalService` +
 * `agentService`. We're just a thin proposal-form adapter for the UI.
 */

import type { Request, Response, Router as ExpressRouter } from "express";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agents as agentsTable } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { agentService } from "../services/agents.js";
import { approvalService } from "../services/approvals.js";
import { logActivity } from "../services/activity-log.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

const proposeAgentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1).max(80),
  title: z.string().trim().max(160).optional().nullable(),
  capabilities: z.string().trim().max(2000).optional().nullable(),
  adapterType: z.enum(["claude_local", "process", "none"]).default("process"),
  reportsTo: z.string().uuid().optional().nullable(),
  budgetMonthlyCents: z.number().int().min(0).max(100_000_00).optional().default(0),
  reason: z.string().trim().max(2000).optional().nullable(),
});

export function recruitingRoutes(db: Db): ExpressRouter {
  const router = Router();
  const agentsSvc = agentService(db);
  const approvalsSvc = approvalService(db);

  /**
   * Propose a new agent hire. Creates a pending_approval agent row
   * and a hire_agent approval in one transaction-like sequence.
   *
   * The caller must be a board user (agents cannot propose hires in
   * this phase — that would require adapter-side prompt tuning and
   * anti-runaway guards that are out of scope).
   */
  router.post(
    "/companies/:companyId/recruiting/propose",
    validate(proposeAgentSchema),
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Only board users can propose hires" });
        return;
      }

      const body = req.body as z.infer<typeof proposeAgentSchema>;
      const actor = getActorInfo(req);

      // Reviewer P0 finding E — cross-tenant reportsTo. Schema only
      // checked that the value was a UUID, not that the referenced
      // agent lived in the SAME company. A board user with write
      // access to company A could propose an agent whose "reports to"
      // pointed at a company B leader, silently linking tenants.
      // Validate BEFORE any insert so we don't leak existence either.
      if (body.reportsTo) {
        const [row] = await db
          .select({ id: agentsTable.id, companyId: agentsTable.companyId })
          .from(agentsTable)
          .where(
            and(
              eq(agentsTable.id, body.reportsTo),
              eq(agentsTable.companyId, companyId),
            ),
          )
          .limit(1);
        if (!row) {
          res
            .status(404)
            .json({ error: "reportsTo agent not found in this company" });
          return;
        }
      }

      // Reviewer P0 finding A — orphan pending agent. The original
      // implementation called agentsSvc.create() + approvalsSvc.create()
      // sequentially with no transaction. If the approval insert failed
      // (FK, constraint, crash) the pending_approval agent row was
      // orphaned and cluttered the agent list forever. Wrap both writes
      // in a single transaction so either both land or neither does.
      const created = await db.transaction(async (tx) => {
        const txAgents = agentService(tx as unknown as Db);
        const txApprovals = approvalService(tx as unknown as Db);

        const agent = await txAgents.create(companyId, {
          name: body.name,
          role: body.role,
          title: body.title ?? null,
          reportsTo: body.reportsTo ?? null,
          capabilities: body.capabilities ?? null,
          adapterType: body.adapterType,
          adapterConfig: {},
          budgetMonthlyCents: body.budgetMonthlyCents ?? 0,
          metadata: { proposedVia: "recruiting", proposalReason: body.reason ?? null },
          status: "pending_approval",
          spentMonthlyCents: 0,
          permissions: undefined,
          lastHeartbeatAt: null,
        });
        if (!agent) {
          throw Object.assign(new Error("Failed to create agent"), { status: 500 });
        }

        const approval = await txApprovals.create(companyId, {
          type: "hire_agent",
          status: "pending",
          requestedByUserId: actor.actorId,
          requestedByAgentId: null,
          payload: {
            agentId: agent.id,
            name: body.name,
            role: body.role,
            title: body.title ?? null,
            capabilities: body.capabilities ?? null,
            adapterType: body.adapterType,
            budgetMonthlyCents: body.budgetMonthlyCents ?? 0,
            reason: body.reason ?? null,
          },
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
        });

        return { agent, approval };
      });
      const { agent, approval } = created;

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "recruiting.proposed",
        entityType: "agent",
        entityId: agent.id,
        details: {
          approvalId: approval.id,
          name: body.name,
          role: body.role,
          adapterType: body.adapterType,
        },
      });

      res.status(201).json({
        agent: { id: agent.id, name: agent.name, status: agent.status },
        approval: { id: approval.id, status: approval.status },
      });
    },
  );

  return router;
}
