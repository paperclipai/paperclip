import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  companyCoordinationWorkQuerySchema,
  coordinationHandoffBodySchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { agentService } from "../services/agents.js";
import {
  companyCoordinationService,
  type CoordinationWakeDispatcher,
} from "../services/company-coordination.js";
import { assertCompanyAccess } from "./authz.js";

function isTaskBridgeKeyActor(req: Request): boolean {
  return (
    req.actor.type === "agent" &&
    req.actor.source === "agent_key" &&
    req.actor.keyScope?.kind === "task_bridge"
  );
}

/**
 * The two narrow, opt-in company coordination endpoints:
 *
 * - GET  /api/companies/:companyId/coordination/work     — bounded open-work list
 * - POST /api/companies/:companyId/coordination/handoffs — addressed handoff to a
 *   project lead through the existing wake machinery
 *
 * Board operators may read the work list (smoke/read), but handoffs are
 * agent-run actions only: they require the explicit canCoordinateCompanyWork
 * grant and a valid active bound run whose source issue exactly matches the
 * request. No scheduler, no generic cross-project API.
 */
export function companyCoordinationRoutes(
  db: Db,
  opts: { heartbeat: { wakeup: CoordinationWakeDispatcher } },
) {
  const router = Router();
  const svc = companyCoordinationService(db, opts.heartbeat.wakeup);

  async function assertAgentCoordinationGrant(agentId: string, companyId: string): Promise<void> {
    const agent = await agentService(db).getById(agentId);
    if (!agent || agent.companyId !== companyId) {
      throw forbidden("Agent cannot coordinate another company", {
        code: "coordination_company_mismatch",
      });
    }
    if (agent.permissions.canCoordinateCompanyWork !== true) {
      throw forbidden("Company coordination authority has not been granted to this agent", {
        code: "coordination_permission_required",
      });
    }
  }

  router.get("/companies/:companyId/coordination/work", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (isTaskBridgeKeyActor(req)) {
      throw forbidden("Task bridge keys cannot use company-wide coordination lists", {
        code: "coordination_key_scope_denied",
      });
    }
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden("Agent context required");
      await assertAgentCoordinationGrant(req.actor.agentId, companyId);
    }
    // ZodError → 400: unknown query parameters are rejected, never ignored.
    const query = companyCoordinationWorkQuerySchema.parse(req.query);
    res.json(await svc.listCompanyWork(companyId, query));
  });

  router.post("/companies/:companyId/coordination/handoffs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      // Board operators may read and smoke-test, but a handoff is an
      // agent-run action: a board actor can never spoof the bound run.
      throw forbidden("Coordination handoffs require an authenticated agent with an active bound run", {
        code: "coordination_actor_required",
      });
    }
    if (isTaskBridgeKeyActor(req)) {
      throw forbidden("Task bridge keys cannot request coordination handoffs", {
        code: "coordination_key_scope_denied",
      });
    }
    if (!req.actor.runId) {
      throw forbidden("Coordination handoff requires an active bound agent run", {
        code: "coordination_run_context_required",
      });
    }
    await assertAgentCoordinationGrant(req.actor.agentId, companyId);
    const body = coordinationHandoffBodySchema.parse(req.body ?? {});
    const result = await svc.createHandoff({
      companyId,
      body,
      actor: {
        agentId: req.actor.agentId,
        runId: req.actor.runId,
        onBehalfOfUserId: req.actor.onBehalfOfUserId ?? null,
      },
    });
    res.json(result);
  });

  return router;
}
