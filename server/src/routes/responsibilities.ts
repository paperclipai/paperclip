import { Router, type NextFunction, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  createResponsibilitySchema,
  delegateResponsibilitySchema,
  linkResponsibilitySchema,
  listResponsibilitiesQuerySchema,
  proposeResponsibilitySchema,
  responsibilityLinkLookupQuerySchema,
  updateResponsibilitySchema,
  type LinkResponsibility,
  type ResponsibilityArea,
  type ResponsibilityLinkLookupQuery,
} from "@paperclipai/shared";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  authorizationDeniedDetails,
  issueReadSqlCondition,
  projectReadSqlCondition,
} from "../services/authorization.js";
import {
  accessService,
  heartbeatService,
  instanceSettingsService,
  issueReferenceService,
  logActivity,
} from "../services/index.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";
import {
  responsibilityService,
  type ResponsibilityLinkTarget,
  type ResponsibilityReadScope,
} from "../services/responsibilities.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

const NOT_FOUND = "Responsibility not found";

/**
 * The create body for this actor: a person may send only a title (the bar is
 * set later), an agent proposing one must always send the whole bar.
 */
function validateCreateResponsibility(req: Request, _res: Response, next: NextFunction) {
  req.body = (req.actor.type === "agent" ? proposeResponsibilitySchema : createResponsibilitySchema).parse(req.body);
  next();
}
const AGENT_LINKABLE_STATUSES = new Set(["proposed", "active"]);

function linkTarget(body: LinkResponsibility | ResponsibilityLinkLookupQuery): ResponsibilityLinkTarget {
  if (body.projectId) return { kind: "project", id: body.projectId };
  if (body.issueId) return { kind: "issue", id: body.issueId };
  return { kind: "routine", id: body.routineId! };
}

/**
 * The writer rule: a board user manages their own responsibilities; company
 * owners/admins and instance admins manage anyone's.
 */
export function boardCanManageResponsibilityOwner(req: Request, companyId: string, ownerUserId: string) {
  if (req.actor.type !== "board") return false;
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
  if (req.actor.userId && req.actor.userId === ownerUserId) return true;
  const membership = req.actor.memberships?.find((item) => item.companyId === companyId && item.status === "active");
  return membership?.membershipRole === "owner" || membership?.membershipRole === "admin";
}

export function responsibilityRoutes(db: Db, opts: { heartbeat?: IssueAssignmentWakeupDeps } = {}) {
  const router = Router();
  const access = accessService(db);
  const settings = instanceSettingsService(db);
  const svc = responsibilityService(db);
  const references = issueReferenceService(db);
  const heartbeat = opts.heartbeat ?? heartbeatService(db);

  // Same gate and message shape the status-card routes use when their flag is off.
  async function assertResponsibilitiesEnabled() {
    const experimental = await settings.getExperimental();
    if (experimental.enableResponsibilities !== true) throw notFound("Responsibilities are not enabled");
  }

  /** Agents also pass the company-scope read boundary (low-trust agents do not). */
  async function assertAgentCompanyScope(req: Request, companyId: string) {
    if (req.actor.type !== "agent") return;
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (!decision.allowed) {
      throw forbidden(
        "Responsibilities are outside this agent's authorization boundary",
        authorizationDeniedDetails(decision),
      );
    }
  }

  async function assertCompanyRead(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board" && req.actor.type !== "agent") throw forbidden("Board or agent access required");
    await assertAgentCompanyScope(req, companyId);
  }

  async function readScope(req: Request): Promise<ResponsibilityReadScope> {
    const [issueReadCondition, projectReadCondition] = await Promise.all([
      issueReadSqlCondition(db, req.actor),
      projectReadSqlCondition(db, req.actor),
    ]);
    return { issueReadCondition, projectReadCondition };
  }

  const boardCanManageOwner = boardCanManageResponsibilityOwner;

  function assertBoardCanManage(req: Request, row: { companyId: string; ownerUserId: string }) {
    if (!boardCanManageOwner(req, row.companyId, row.ownerUserId)) {
      throw forbidden("Only the person who owns this responsibility, or a company admin, can change it");
    }
  }

  async function loadForRead(req: Request, res: Response) {
    const row = await getAccessibleResource(req, res, svc.getById(req.params.id as string), NOT_FOUND);
    if (!row) return null;
    await assertCompanyRead(req, row.companyId);
    return row;
  }

  /** Load for a mutation: board users must manage the owner; agents pass the company-scope boundary. */
  async function loadForWrite(req: Request, res: Response) {
    const row = await loadForRead(req, res);
    if (!row) return null;
    if (req.actor.type === "board") assertBoardCanManage(req, row);
    return row;
  }

  function assertAgentMayFileUnder(req: Request, row: { status: string }) {
    if (req.actor.type === "agent" && !AGENT_LINKABLE_STATUSES.has(row.status)) {
      throw unprocessable("Agents can only file work under a proposed or active responsibility");
    }
  }

  async function logMutation(
    req: Request,
    companyId: string,
    action: string,
    entityId: string,
    details?: Record<string, unknown>,
  ) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action,
      entityType: "responsibility",
      entityId,
      details,
    });
  }

  async function logAreaActivated(req: Request, area: ResponsibilityArea | null, responsibilityId: string) {
    if (!area) return;
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: area.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "responsibility_area.activated",
      entityType: "responsibility_area",
      entityId: area.id,
      details: { title: area.title, responsibilityId },
    });
  }

  router.get("/companies/:companyId/responsibilities", async (req, res) => {
    await assertResponsibilitiesEnabled();
    const companyId = req.params.companyId as string;
    await assertCompanyRead(req, companyId);
    const query = listResponsibilitiesQuerySchema.parse(req.query);
    const ownerUserId = query.ownerUserId ?? (req.actor.type === "board" ? req.actor.userId : undefined);
    if (!ownerUserId) {
      throw unprocessable(req.actor.type === "agent"
        ? "ownerUserId is required: name the person whose responsibilities to read"
        : "ownerUserId is required");
    }
    res.json(await svc.overview(companyId, ownerUserId, {
      includeLetGo: query.includeLetGo,
      scope: await readScope(req),
    }));
  });

  router.post("/companies/:companyId/responsibilities", validateCreateResponsibility, async (req, res) => {
    await assertResponsibilitiesEnabled();
    const companyId = req.params.companyId as string;
    await assertCompanyRead(req, companyId);
    const actor = getActorInfo(req);
    let ownerUserId: string;
    if (req.actor.type === "agent") {
      if (!req.body.ownerUserId) {
        throw unprocessable("ownerUserId is required: an agent proposes a responsibility for a person in this company");
      }
      ownerUserId = req.body.ownerUserId;
      if (!(await svc.isCompanyMember(companyId, ownerUserId))) throw notFound("Owner is not a member of this company");
    } else {
      const self = req.actor.userId;
      ownerUserId = req.body.ownerUserId ?? self ?? "";
      if (!ownerUserId) throw unprocessable("ownerUserId is required");
      if (ownerUserId !== self) {
        if (!boardCanManageOwner(req, companyId, ownerUserId)) {
          throw forbidden("Only a company admin can create a responsibility for another person");
        }
        if (!(await svc.isCompanyMember(companyId, ownerUserId))) throw notFound("Owner is not a member of this company");
      }
    }
    const { responsibility: created, activatedArea } = await svc.create(
      companyId,
      req.body,
      req.actor.type === "agent" ? { type: "agent", agentId: actor.actorId } : { type: "board", userId: actor.actorId },
      ownerUserId,
    );
    await logMutation(req, companyId, "responsibility.created", created.id, {
      title: created.title,
      ownerUserId: created.ownerUserId,
      status: created.status,
      source: created.source,
      areaId: created.areaId,
    });
    await logAreaActivated(req, activatedArea, created.id);
    res.status(201).json(await svc.withRollup(created, await readScope(req)));
  });

  router.get("/responsibilities/:id", async (req, res) => {
    await assertResponsibilitiesEnabled();
    const row = await loadForRead(req, res);
    if (!row) return;
    res.json(await svc.detail(row, await readScope(req), { actor: req.actor }));
  });

  router.patch("/responsibilities/:id", validate(updateResponsibilitySchema), async (req, res) => {
    await assertResponsibilitiesEnabled();
    const row = await loadForWrite(req, res);
    if (!row) return;
    const scope = await readScope(req);
    const { responsibility: updated, activatedArea } = await svc.update(
      row,
      req.body,
      req.actor.type === "agent" ? { type: "agent", agentId: getActorInfo(req).actorId, scope } : { type: "board", userId: getActorInfo(req).actorId },
    );
    const otherFields = Object.keys(req.body).filter((key) => key !== "metricCurrent");
    if (otherFields.length > 0) {
      await logMutation(req, row.companyId, "responsibility.updated", row.id, {
        fields: otherFields,
        ...(req.body.status !== undefined ? { fromStatus: row.status, toStatus: updated.status } : {}),
        ...(req.body.healthOverride !== undefined ? { healthOverride: updated.healthOverride } : {}),
        ...(req.body.areaId !== undefined ? { fromAreaId: row.areaId, toAreaId: updated.areaId } : {}),
        ...(req.body.runByAgentId !== undefined ? { fromRunByAgentId: row.runByAgentId, toRunByAgentId: updated.runByAgentId } : {}),
      });
    }
    if (req.body.metricCurrent !== undefined) {
      await logMutation(req, row.companyId, "responsibility.metric_updated", row.id, {
        metricName: updated.metricName,
        from: row.metricCurrent === null ? null : Number(row.metricCurrent),
        to: updated.metricCurrent === null ? null : Number(updated.metricCurrent),
      });
    }
    await logAreaActivated(req, activatedArea, row.id);
    res.json(await svc.withRollup(updated, scope));
  });

  router.delete("/responsibilities/:id", async (req, res) => {
    await assertResponsibilitiesEnabled();
    assertBoard(req);
    const row = await loadForWrite(req, res);
    if (!row) return;
    const removed = await svc.remove(row);
    if (!removed) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    await logMutation(req, row.companyId, "responsibility.deleted", row.id, { title: row.title, ownerUserId: row.ownerUserId });
    res.json(removed);
  });

  router.post("/responsibilities/:id/links", validate(linkResponsibilitySchema), async (req, res) => {
    await assertResponsibilitiesEnabled();
    const row = await loadForWrite(req, res);
    if (!row) return;
    assertAgentMayFileUnder(req, row);
    const target = linkTarget(req.body);
    const result = await svc.link(row, target, await readScope(req));
    if (result.created) {
      await logMutation(req, row.companyId, "responsibility.linked", row.id, {
        linkId: result.link.id,
        targetType: target.kind,
        targetId: target.id,
      });
    }
    const body = { link: result.link };
    if (result.created) {
      res.status(201).json(body);
      return;
    }
    res.json(body);
  });

  router.delete("/responsibilities/:id/links/:linkId", async (req, res) => {
    await assertResponsibilitiesEnabled();
    const row = await loadForWrite(req, res);
    if (!row) return;
    assertAgentMayFileUnder(req, row);
    const removed = await svc.unlink(row, req.params.linkId as string);
    if (!removed) {
      res.status(404).json({ error: "Link not found" });
      return;
    }
    const targetType = removed.projectId ? "project" : removed.issueId ? "issue" : "routine";
    await logMutation(req, row.companyId, "responsibility.unlinked", row.id, {
      linkId: removed.id,
      targetType,
      targetId: removed.projectId ?? removed.issueId ?? removed.routineId,
    });
    res.json(removed);
  });

  router.post("/responsibilities/:id/delegate", validate(delegateResponsibilitySchema), async (req, res) => {
    await assertResponsibilitiesEnabled();
    assertBoard(req);
    const row = await loadForWrite(req, res);
    if (!row) return;
    if (row.status !== "active") {
      throw unprocessable("Confirm this responsibility before handing work to an agent under it");
    }
    // The same assignment permission the task-create route checks for a board assignee.
    const decision = await access.decide({
      actor: req.actor,
      action: "tasks:assign",
      resource: {
        type: "issue",
        companyId: row.companyId,
        issueId: null,
        projectId: req.body.projectId ?? null,
        parentIssueId: null,
        assigneeAgentId: req.body.assigneeAgentId,
        assigneeUserId: null,
      },
    });
    if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
    const actor = getActorInfo(req);
    const { issue, link, runByAgentId, runByAgentChanged } = await svc.delegate(row, req.body, {
      userId: actor.actorId,
      runId: actor.runId,
      identityContextId: req.actor.identityContextId ?? null,
      authorizationActor: req.actor,
    }, await readScope(req));
    await references.syncIssue(issue.id);
    await logActivity(db, {
      companyId: row.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.created",
      entityType: "issue",
      entityId: issue.id,
      details: { title: issue.title, identifier: issue.identifier, responsibilityId: row.id },
    });
    await logMutation(req, row.companyId, "responsibility.delegated", row.id, {
      issueId: issue.id,
      identifier: issue.identifier,
      linkId: link.id,
      assigneeAgentId: issue.assigneeAgentId,
      mode: req.body.mode,
      ...(runByAgentChanged ? { fromRunByAgentId: row.runByAgentId, toRunByAgentId: runByAgentId } : {}),
    });
    void queueIssueAssignmentWakeup({
      heartbeat,
      issue,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "responsibility.delegate",
      requestedByActorType: "user",
      requestedByActorId: actor.actorId,
    });
    res.status(201).json({ issue, link });
  });

  router.get("/companies/:companyId/responsibility-links/lookup", async (req, res) => {
    await assertResponsibilitiesEnabled();
    const companyId = req.params.companyId as string;
    await assertCompanyRead(req, companyId);
    const query = responsibilityLinkLookupQuerySchema.parse(req.query);
    const responsibilities = await svc.lookup(companyId, linkTarget(query), await readScope(req));
    res.json({ responsibilities });
  });

  return router;
}
