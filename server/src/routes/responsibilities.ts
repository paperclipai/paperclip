import { Router, type NextFunction, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  createResponsibilitySchema,
  delegateResponsibilitySchema,
  deleteResponsibilityQuerySchema,
  fileResponsibilityItemsSchema,
  linkResponsibilitySchema,
  listResponsibilitiesQuerySchema,
  proposeResponsibilitySchema,
  responsibilityLinkLookupQuerySchema,
  unfileResponsibilityItemsSchema,
  updateResponsibilitySchema,
  type LinkResponsibility,
  type ResponsibilityFileItemKind,
  type ResponsibilityArea,
  type ResponsibilityLinkLookupQuery,
} from "@paperclipai/shared";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { responsibilitiesDisabledError } from "../services/responsibilities-disabled.js";
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
import { responsibilityAgentChangeService, responsibilityDeletionKey } from "../services/responsibility-agent-changes.js";
import {
  responsibilityService,
  type ResponsibilityLinkTarget,
  type ResponsibilityReadScope,
} from "../services/responsibilities.js";
import { assertBoard, assertBoardOrAgent, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

const NOT_FOUND = "Responsibility not found";

/**
 * The create body for this actor: a person, or an agent acting for a person
 * in the company, may send only a title (the bar is set later); any other
 * agent proposing one must always send the whole bar.
 */
function validateCreateResponsibility(req: Request, _res: Response, next: NextFunction) {
  const fullCreate = req.actor.type !== "agent" || agentPersonInCompany(req, req.params.companyId as string) !== null;
  req.body = (fullCreate ? createResponsibilitySchema : proposeResponsibilitySchema).parse(req.body);
  next();
}
const AGENT_LINKABLE_STATUSES = new Set(["proposed", "active"]);

function fileTarget(item: { kind: ResponsibilityFileItemKind; id: string }): ResponsibilityLinkTarget {
  return { kind: item.kind === "task" ? "issue" : item.kind, id: item.id };
}

function linkTargetType(link: { projectId: string | null; issueId: string | null }) {
  return link.projectId ? "project" : link.issueId ? "issue" : "routine";
}

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

/**
 * The person an agent's run works for (the person chatting, or the task's
 * responsible person), while they are an active member of `companyId`.
 */
export function agentPersonInCompany(req: Request, companyId: string): { userId: string; role: string | null } | null {
  if (req.actor.type !== "agent" || !req.actor.onBehalfOfUserId) return null;
  const membership = req.actor.onBehalfOfMemberships?.find((item) => item.companyId === companyId && item.status === "active");
  return membership ? { userId: req.actor.onBehalfOfUserId, role: membership.membershipRole ?? null } : null;
}

/**
 * The writer rule for an agent: it acts for the person its run works for and
 * may change what that person could, so it manages that person's own
 * responsibilities, and anyone's when that person is a company owner or
 * admin. Returns that person's user id, or null.
 */
export function agentActsForResponsibilityOwner(req: Request, companyId: string, ownerUserId: string): string | null {
  const person = agentPersonInCompany(req, companyId);
  if (!person) return null;
  return person.userId === ownerUserId || person.role === "owner" || person.role === "admin" ? person.userId : null;
}

/**
 * Whose responsibilities a request means when it names no owner: a board user
 * means their own, and an agent means the person its run works for (the
 * person chatting, or the task's responsible person).
 */
export function defaultResponsibilityOwnerUserId(req: Request): string | undefined {
  if (req.actor.type === "board") return req.actor.userId ?? undefined;
  if (req.actor.type === "agent") return req.actor.onBehalfOfUserId ?? undefined;
  return undefined;
}

export function responsibilityRoutes(db: Db, opts: { heartbeat?: IssueAssignmentWakeupDeps } = {}) {
  const router = Router();
  const access = accessService(db);
  const agentChanges = responsibilityAgentChangeService(db);
  const settings = instanceSettingsService(db);
  const svc = responsibilityService(db);
  const references = issueReferenceService(db);
  const heartbeat = opts.heartbeat ?? heartbeatService(db);

  // Same gate and message shape the status-card routes use when their flag is off.
  async function assertResponsibilitiesEnabled() {
    const experimental = await settings.getExperimental();
    if (experimental.enableResponsibilities !== true) throw responsibilitiesDisabledError();
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

  function assertAgentMayFileUnder(req: Request, row: { companyId: string; ownerUserId: string; status: string }) {
    if (req.actor.type === "agent" && !AGENT_LINKABLE_STATUSES.has(row.status)
      && !agentActsForResponsibilityOwner(req, row.companyId, row.ownerUserId)) {
      throw unprocessable("Agents can only file work under a proposed or active responsibility");
    }
  }

  /** A board user who manages the owner, or an agent acting for someone who does (versioned as the agent's change). */
  function assertWriter(req: Request, row: { companyId: string; ownerUserId: string }) {
    if (req.actor.type === "board") {
      assertBoardCanManage(req, row);
      return null;
    }
    const personUserId = agentActsForResponsibilityOwner(req, row.companyId, row.ownerUserId);
    if (!personUserId) {
      throw forbidden("Only the person who owns this responsibility, or a company admin, can change it; this agent's run does not work for such a person");
    }
    return { personUserId, agentId: getActorInfo(req).actorId };
  }

  /** Run an agent's change for a person as a Dashboard version they can undo; a board change runs as is. */
  async function asAgentChange<T>(
    req: Request,
    input: { companyId: string; ownerUserIds: readonly string[] },
    mutate: () => Promise<T>,
  ): Promise<T> {
    const actor = getActorInfo(req);
    if (req.actor.type !== "agent" || !actor.agentId) return mutate();
    return agentChanges.record({ companyId: input.companyId, ownerUserIds: input.ownerUserIds, agentId: actor.agentId }, mutate);
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
      // An agent's change records the person it acted for: "agent X, for person Y".
      details: req.actor.type === "agent" && req.actor.onBehalfOfUserId
        ? { ...details, onBehalfOfUserId: req.actor.onBehalfOfUserId }
        : details,
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
    const ownerUserId = query.ownerUserId ?? defaultResponsibilityOwnerUserId(req);
    if (!ownerUserId) {
      throw unprocessable(req.actor.type === "agent"
        ? "ownerUserId is required: this run works for no person, so name the person whose responsibilities to read"
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
    // An agent acting for someone who may manage the owner creates what that person could.
    let actsFor: string | null = null;
    if (req.actor.type === "agent") {
      const owner = req.body.ownerUserId ?? defaultResponsibilityOwnerUserId(req);
      if (!owner) {
        throw unprocessable("ownerUserId is required: this run works for no person, so name the person in this company the responsibility is for");
      }
      ownerUserId = owner;
      if (!(await svc.isCompanyMember(companyId, ownerUserId))) throw notFound("Owner is not a member of this company");
      actsFor = agentActsForResponsibilityOwner(req, companyId, ownerUserId);
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
    const { responsibility: created, activatedArea } = await asAgentChange(req, { companyId, ownerUserIds: actsFor ? [ownerUserId] : [] }, () => svc.create(
      companyId,
      req.body,
      req.actor.type !== "agent" ? { type: "board", userId: actor.actorId }
        : actsFor ? { type: "board", userId: actsFor, viaAgentId: actor.actorId }
          : { type: "agent", agentId: actor.actorId },
      ownerUserId,
    ));
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
    const actsFor = req.actor.type === "agent" ? agentActsForResponsibilityOwner(req, row.companyId, row.ownerUserId) : null;
    const { responsibility: updated, activatedArea } = await asAgentChange(req, { companyId: row.companyId, ownerUserIds: actsFor ? [row.ownerUserId] : [] }, () => svc.update(
      row,
      req.body,
      req.actor.type !== "agent" ? { type: "board", userId: getActorInfo(req).actorId }
        : actsFor ? { type: "board", userId: actsFor, viaAgentId: getActorInfo(req).actorId }
          : { type: "agent", agentId: getActorInfo(req).actorId, scope },
    ));
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
    assertBoardOrAgent(req);
    const row = await loadForWrite(req, res);
    if (!row) return;
    let confirmationId: string | null = null;
    if (req.actor.type === "agent") {
      // Permanent and not undoable: an agent deletes only after the person accepts its confirmation card.
      const writer = assertWriter(req, row)!;
      const card = await agentChanges.assertConfirmedDeletion({
        companyId: row.companyId,
        agentId: writer.agentId,
        interactionId: deleteResponsibilityQuerySchema.parse(req.query).confirmationId,
        key: responsibilityDeletionKey("responsibility", row.id),
        ownerUserId: row.ownerUserId,
      });
      confirmationId = card.id;
    }
    const removed = await svc.remove(row);
    if (!removed) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    await logMutation(req, row.companyId, "responsibility.deleted", row.id, {
      title: row.title,
      ownerUserId: row.ownerUserId,
      ...(confirmationId ? { confirmationInteractionId: confirmationId } : {}),
    });
    res.json(removed);
  });

  router.post("/responsibilities/:id/links", validate(linkResponsibilitySchema), async (req, res) => {
    await assertResponsibilitiesEnabled();
    const row = await loadForWrite(req, res);
    if (!row) return;
    assertAgentMayFileUnder(req, row);
    const target = linkTarget(req.body);
    const actsFor = req.actor.type === "agent" ? agentActsForResponsibilityOwner(req, row.companyId, row.ownerUserId) : null;
    const scope = await readScope(req);
    const result = await asAgentChange(req, { companyId: row.companyId, ownerUserIds: actsFor ? [row.ownerUserId] : [] },
      () => svc.link(row, target, scope));
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
    const actsFor = req.actor.type === "agent" ? agentActsForResponsibilityOwner(req, row.companyId, row.ownerUserId) : null;
    const removed = await asAgentChange(req, { companyId: row.companyId, ownerUserIds: actsFor ? [row.ownerUserId] : [] },
      () => svc.unlink(row, req.params.linkId as string));
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

  /**
   * File projects, tasks and routines under a responsibility in one step;
   * with `moveFrom` they also leave that responsibility (or, with `all`, every
   * other proposed or active one of the same owner). A board user who manages
   * the owner, or an agent acting for such a person; an agent's change is
   * saved as a Dashboard version the person can undo.
   */
  router.post("/responsibilities/:id/file", validate(fileResponsibilityItemsSchema), async (req, res) => {
    await assertResponsibilitiesEnabled();
    const row = await loadForWrite(req, res);
    if (!row) return;
    assertWriter(req, row);
    const targets = req.body.items.map(fileTarget);
    let moveFromIds: string[] = [];
    const owners = new Set([row.ownerUserId]);
    if (req.body.moveFrom === "all") {
      moveFromIds = await svc.liveIdsOfOwner(row.companyId, row.ownerUserId, row.id);
    } else if (req.body.moveFrom && req.body.moveFrom !== row.id) {
      const source = await svc.getById(req.body.moveFrom);
      if (!source || source.companyId !== row.companyId) throw notFound("Responsibility to move from not found");
      assertWriter(req, source);
      moveFromIds = [source.id];
      owners.add(source.ownerUserId);
    }
    const scope = await readScope(req);
    const result = await asAgentChange(req, { companyId: row.companyId, ownerUserIds: [...owners] },
      () => svc.fileItems(row, targets, scope, { moveFromIds }));
    for (const entry of result.filed.filter((item) => item.created)) {
      await logMutation(req, row.companyId, "responsibility.linked", row.id, {
        linkId: entry.link.id,
        targetType: entry.target.kind,
        targetId: entry.target.id,
      });
    }
    for (const link of result.unfiled) {
      await logMutation(req, row.companyId, "responsibility.unlinked", link.responsibilityId, {
        linkId: link.id,
        targetType: linkTargetType(link),
        targetId: link.projectId ?? link.issueId ?? link.routineId,
        movedToResponsibilityId: row.id,
      });
    }
    res.json({
      filed: result.filed.map((entry) => ({ link: entry.link, created: entry.created })),
      unfiled: result.unfiled,
    });
  });

  /** Unfile items from a responsibility by kind and id; items not filed there are skipped. */
  router.post("/responsibilities/:id/unfile", validate(unfileResponsibilityItemsSchema), async (req, res) => {
    await assertResponsibilitiesEnabled();
    const row = await loadForWrite(req, res);
    if (!row) return;
    assertWriter(req, row);
    const targets = req.body.items.map(fileTarget);
    const removed = await asAgentChange(req, { companyId: row.companyId, ownerUserIds: [row.ownerUserId] },
      () => svc.unfileItems(row, targets));
    for (const link of removed) {
      await logMutation(req, row.companyId, "responsibility.unlinked", row.id, {
        linkId: link.id,
        targetType: linkTargetType(link),
        targetId: link.projectId ?? link.issueId ?? link.routineId,
      });
    }
    res.json({ unfiled: removed });
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
