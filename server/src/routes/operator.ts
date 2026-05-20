// operator.ts — operator-scope endpoints for spawn-time provisioning.
//
// RINA-79: OpenClaw spawns persona subagents (cfo, etc) and needs to mint a
// per-agent Paperclip API key for each one BEFORE the subagent's first wake.
// The existing key-mint endpoint (`POST /agents/:id/keys`) requires board
// access; OpenClaw runs as an agent. This route lets an agent with
// `canCreateAgents` permission claim a key on behalf of a sibling agent in
// the same company. The audit log records who claimed it so provenance is
// clean.
//
// Smart approval (companion): classifies a proposed action into
// execute/notify/approve. Companion to rule-of-two; additive, not a
// replacement. Every classification is appended to the activity log so the
// trail of fast-execute decisions is durable. Callers (Hermes, OpenClaw)
// can mirror to GBrain `rinc/approvals/<YYYY-MM-DD>` via their own MCP.

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { agentService, logActivity } from "../services/index.js";
import { classifyAction, type SmartApprovalAction } from "../services/smart-approval.js";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { assertAuthenticated } from "./authz.js";
import { validate } from "../middleware/validate.js";

const claimAgentKeySchema = z.object({
  agentId: z.string().trim().min(1),
  name: z.string().trim().min(1).optional().default("claimed"),
});

const classifyActionSchema = z.object({
  kind: z.string().trim().min(1),
  capabilityTags: z
    .object({
      untrusted: z.boolean().optional(),
      private: z.boolean().optional(),
      external_state_change: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  costDeltaUsdPerMonth: z.number().nullable().optional(),
  callCostUsd: z.number().nullable().optional(),
  branch: z.string().nullable().optional(),
  // Optional context for the audit log. The audit-log companyId is always
  // derived from the caller's actor scope — callers cannot supply it.
  targetEntityType: z.string().trim().min(1).optional(),
  targetEntityId: z.string().trim().min(1).optional(),
});

// An operator-scope caller is either:
//   - a board user (instance admin or someone with agents:create on the
//     target company), OR
//   - an agent with the canCreateAgents permission in the target agent's
//     company.
//
// Returns the caller's company scope (or null for instance-admin boards).
async function assertOperatorScopeForAgent(
  req: Request,
  svc: ReturnType<typeof agentService>,
  targetAgentId: string,
) {
  assertAuthenticated(req);

  const targetAgent = await svc.getById(targetAgentId);
  if (!targetAgent) {
    throw notFound("Agent not found");
  }
  if (targetAgent.status === "terminated") {
    throw unprocessable("Cannot claim key for terminated agent");
  }
  if (targetAgent.status === "pending_approval") {
    throw unprocessable("Cannot claim key for pending-approval agent");
  }

  if (req.actor.type === "board") {
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
      return targetAgent;
    }
    const allowedCompanies = req.actor.companyIds ?? [];
    if (!allowedCompanies.includes(targetAgent.companyId)) {
      throw forbidden("User does not have access to target agent's company");
    }
    return targetAgent;
  }

  if (req.actor.type === "agent") {
    if (!req.actor.agentId || !req.actor.companyId) {
      throw forbidden("Agent authentication required");
    }
    if (req.actor.companyId !== targetAgent.companyId) {
      throw forbidden("Operator agent cannot access another company");
    }
    const callerAgent = await svc.getById(req.actor.agentId);
    if (!callerAgent) {
      throw forbidden("Calling agent not found");
    }
    const perms = (callerAgent.permissions as Record<string, unknown> | null) ?? {};
    const canCreate = perms.canCreateAgents === true || callerAgent.role === "ceo";
    if (!canCreate) {
      throw forbidden("Operator-scope (canCreateAgents) required to claim keys");
    }
    return targetAgent;
  }

  throw forbidden("Operator-scope caller required");
}

export function operatorRoutes(db: Db) {
  const router = Router();
  const svc = agentService(db);

  // RINA-79: claim an api key for another agent.
  router.post(
    "/operator/claim-agent-key",
    validate(claimAgentKeySchema),
    async (req: Request, res: Response) => {
      const { agentId, name } = req.body as z.infer<typeof claimAgentKeySchema>;
      const target = await assertOperatorScopeForAgent(req, svc, agentId);
      const key = await svc.createApiKey(target.id, name);

      const claimedBy =
        req.actor.type === "agent"
          ? { actorType: "agent" as const, actorId: req.actor.agentId ?? "agent" }
          : { actorType: "user" as const, actorId: req.actor.userId ?? "board" };

      await logActivity(db, {
        companyId: target.companyId,
        actorType: claimedBy.actorType,
        actorId: claimedBy.actorId,
        action: "agent.key_claimed_by_operator",
        entityType: "agent",
        entityId: target.id,
        details: {
          keyId: key.id,
          name: key.name,
          claimedFor: target.id,
          claimedByAgentId: req.actor.type === "agent" ? req.actor.agentId ?? null : null,
          claimedByUserId: req.actor.type === "board" ? req.actor.userId ?? null : null,
        },
      });

      res.status(201).json({
        api_key: key.token,
        agent_id: target.id,
        key_id: key.id,
        name: key.name,
        created_at: key.createdAt,
      });
    },
  );

  // Smart approval: classify a proposed action.
  router.post(
    "/operator/classify-action",
    validate(classifyActionSchema),
    async (req: Request, res: Response) => {
      assertAuthenticated(req);
      const body = req.body as z.infer<typeof classifyActionSchema>;
      const action: SmartApprovalAction = {
        kind: body.kind,
        capabilityTags: body.capabilityTags ?? null,
        costDeltaUsdPerMonth: body.costDeltaUsdPerMonth ?? null,
        callCostUsd: body.callCostUsd ?? null,
        branch: body.branch ?? null,
      };
      const evaluation = classifyAction(action);

      // Persist to activity log so the trail of fast-execute decisions is
      // durable. companyId is derived from the caller's actor scope only —
      // body-supplied companyId is intentionally ignored to prevent
      // cross-company audit-log injection. For agent callers we use their
      // own companyId; for single-company board callers we use the one
      // company they have access to. Board callers with multiple companies
      // (or none) skip the audit entry — the classifier still returns its
      // verdict.
      let companyId: string | undefined;
      if (req.actor.type === "agent") {
        companyId = req.actor.companyId;
      } else if (req.actor.type === "board") {
        const allowed = req.actor.companyIds ?? [];
        if (allowed.length === 1) {
          companyId = allowed[0];
        }
      }

      if (companyId) {
        await logActivity(db, {
          companyId,
          actorType: req.actor.type === "agent" ? "agent" : "user",
          actorId:
            req.actor.type === "agent"
              ? req.actor.agentId ?? "agent"
              : req.actor.userId ?? "board",
          action: "smart_approval.classified",
          entityType: body.targetEntityType ?? "smart_approval_action",
          entityId: body.targetEntityId ?? body.kind,
          details: {
            kind: body.kind,
            class: evaluation.class,
            decision: evaluation.decision,
            reasons: evaluation.reasons,
            capabilityTags: body.capabilityTags ?? null,
            costDeltaUsdPerMonth: body.costDeltaUsdPerMonth ?? null,
            callCostUsd: body.callCostUsd ?? null,
            branch: body.branch ?? null,
          },
        });
      }

      res.json({
        class: evaluation.class,
        decision: evaluation.decision,
        reasons: evaluation.reasons,
      });
    },
  );

  // Convenience: list the smart-approval matrix for callers that want to
  // mirror it client-side without re-deriving rules.
  router.get("/operator/smart-approval/matrix", (req: Request, res: Response) => {
    assertAuthenticated(req);
    res.json({
      executeClasses: [
        "file_edit",
        "cache_write",
        "search",
        "paperclip_comment",
        "gbrain_page_write",
        "small_api_call",
        "repo_commit",
      ],
      notifyClasses: ["git_push_feature"],
      approveClasses: [
        "git_push_main",
        "git_force_push",
        "external_email",
        "iam_change",
        "cron_change",
        "sudoers_change",
        "cost_bearing",
        "untrusted_external",
      ],
      thresholds: {
        smallCallUsd: 0.5,
        costThresholdUsdPerMonth: 50,
      },
      ruleOfTwoNote:
        "untrusted + external_state_change always routes to approve regardless of action class",
    });
  });

  return router;
}

// Re-export helpers so tests / non-route callers can use the classifier
// and operator-scope check directly.
export { classifyAction } from "../services/smart-approval.js";
export type {
  SmartApprovalAction,
  SmartApprovalEvaluation,
  SmartApprovalDecision,
  SmartApprovalActionClass,
} from "../services/smart-approval.js";
