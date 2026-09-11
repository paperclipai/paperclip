import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createExecutionProfileSchema,
  escalateRouteSchema,
  overrideRouteSchema,
  releaseRouteClaimSchema,
  rescueRouteSchema,
  routeIssueSchema,
  routeRuleDefaultsBindingsSchema,
  updateExecutionProfileSchema,
  upsertRouteRuleSchema,
} from "@paperclipai/shared";
import { HttpError, forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { issueService } from "../services/issues.js";
import { routingService, type RoutingActor, type RoutingWakeup } from "../services/routing/service.js";
import { assertBoardOrAgent, assertBoardOrgAccess, assertCompanyAccess, getActorInfo } from "./authz.js";

function routingActor(req: Request): RoutingActor {
  const actor = getActorInfo(req);
  return {
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    userId: actor.actorType === "user" ? actor.actorId : null,
    runId: actor.runId,
    agentApiKeyId: actor.agentApiKeyId,
    responsibleUserId: req.actor.onBehalfOfUserId ?? (actor.actorType === "user" ? actor.actorId : null),
  };
}

function assertStandardAgentScope(req: Request) {
  if (req.actor.type !== "agent") return;
  if (req.actor.keyScope && req.actor.keyScope.kind !== "standard") {
    throw forbidden("This key scope cannot participate in task routing", { code: "routing_key_scope_denied" });
  }
}

/**
 * Task-attempt routing surface.
 *
 * Board operators configure execution profiles and route rules and hold every
 * authority that changes who works: dispatch, escalate, rescue, override, and
 * claim release. Agents may submit classification facts for issues they can
 * see and request the independent review the decision already requires; they
 * can never choose or waive a worker, reviewer, or advisor.
 */
export function routingRoutes(db: Db, opts: { enqueueWakeup?: RoutingWakeup | null } = {}) {
  const router = Router();
  const svc = routingService(db, { enqueueWakeup: opts.enqueueWakeup ?? null });
  const issuesSvc = issueService(db);

  async function issueCompany(req: Request, issueId: string) {
    const issue = await issuesSvc.getById(issueId);
    if (!issue) throw notFound("Issue not found");
    assertBoardOrAgent(req);
    assertCompanyAccess(req, issue.companyId);
    assertStandardAgentScope(req);
    return issue;
  }

  function assertBoardCompany(req: Request, companyId: string) {
    assertBoardOrgAccess(req);
    assertCompanyAccess(req, companyId);
  }

  // --- execution profiles ---------------------------------------------------

  router.get("/companies/:companyId/execution-profiles", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardOrAgent(req);
    assertCompanyAccess(req, companyId);
    assertStandardAgentScope(req);
    res.json(await svc.listProfiles(companyId));
  });

  router.post("/companies/:companyId/execution-profiles", validate(createExecutionProfileSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardCompany(req, companyId);
    res.status(201).json(await svc.createProfile(companyId, req.body, routingActor(req)));
  });

  router.patch("/execution-profiles/:profileId", validate(updateExecutionProfileSchema), async (req, res) => {
    const profile = await svc.getProfile(req.params.profileId as string);
    if (!profile) throw notFound("Execution profile not found");
    assertBoardCompany(req, profile.companyId);
    res.json(await svc.updateProfile(profile.companyId, profile.id, req.body, routingActor(req)));
  });

  // --- route rules ----------------------------------------------------------

  router.get("/companies/:companyId/route-rules", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardOrAgent(req);
    assertCompanyAccess(req, companyId);
    assertStandardAgentScope(req);
    res.json(await svc.listRules(companyId));
  });

  router.put("/companies/:companyId/route-rules", validate(upsertRouteRuleSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardCompany(req, companyId);
    const result = await svc.upsertRule(companyId, req.body, routingActor(req));
    res.status(result.created ? 201 : 200).json(result.rule);
  });

  router.post("/companies/:companyId/route-rules/defaults", validate(routeRuleDefaultsBindingsSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardCompany(req, companyId);
    res.json(await svc.applyDefaultRules(companyId, req.body, routingActor(req)));
  });

  // --- issue routing --------------------------------------------------------

  router.get("/issues/:issueId/routing", async (req, res) => {
    const issue = await issueCompany(req, req.params.issueId as string);
    res.json(await svc.getIssueRouting(issue.id));
  });

  router.post("/issues/:issueId/routing/route", validate(routeIssueSchema), async (req, res) => {
    const issue = await issueCompany(req, req.params.issueId as string);
    const result = await svc.routeIssue(issue.id, req.body.facts, routingActor(req));
    res.status(result.created ? 201 : 200).json(result.decision);
  });

  router.post("/issues/:issueId/routing/dispatch", async (req, res) => {
    const issue = await issueCompany(req, req.params.issueId as string);
    assertBoardOrgAccess(req);
    res.json(await svc.dispatch(issue.id, routingActor(req)));
  });

  router.post("/issues/:issueId/routing/escalate", validate(escalateRouteSchema), async (req, res) => {
    const issue = await issueCompany(req, req.params.issueId as string);
    assertBoardOrgAccess(req);
    res.status(201).json(await svc.escalate(issue.id, req.body.reason, req.body.note, routingActor(req)));
  });

  router.post("/issues/:issueId/routing/rescue", validate(rescueRouteSchema), async (req, res) => {
    const issue = await issueCompany(req, req.params.issueId as string);
    assertBoardOrgAccess(req);
    const actor = routingActor(req);
    const decision = await svc.escalate(issue.id, req.body.reason, req.body.note, actor);
    if (decision.state !== "routed") {
      res.status(201).json({ decision, dispatch: null, dispatchError: null });
      return;
    }
    // The rescue revision is already durable; a dispatch conflict (live run,
    // exhausted pool slot, model drift) is reported next to it rather than
    // hiding the recorded revision behind a bare 409.
    try {
      res.status(201).json({ decision, dispatch: await svc.dispatch(issue.id, actor), dispatchError: null });
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 409)) throw error;
      const details = error.details && typeof error.details === "object" ? error.details : {};
      res.status(201).json({ decision, dispatch: null, dispatchError: { message: error.message, ...details } });
    }
  });

  router.post("/issues/:issueId/routing/override", validate(overrideRouteSchema), async (req, res) => {
    const issue = await issueCompany(req, req.params.issueId as string);
    assertBoardOrgAccess(req);
    res.status(201).json(await svc.override(issue.id, req.body, routingActor(req)));
  });

  router.post("/issues/:issueId/routing/review-request", async (req, res) => {
    const issue = await issueCompany(req, req.params.issueId as string);
    res.json(await svc.requestReview(issue.id, routingActor(req)));
  });

  router.post("/issues/:issueId/routing/release-claim", validate(releaseRouteClaimSchema), async (req, res) => {
    const issue = await issueCompany(req, req.params.issueId as string);
    assertBoardOrgAccess(req);
    const claim = await svc.releaseIssueClaim(issue.id, req.body.role, req.body.reason, routingActor(req));
    if (!claim) throw notFound("No active claim for that role");
    res.json(claim);
  });

  return router;
}
