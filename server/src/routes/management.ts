import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, projects } from "@paperclipai/db";
import type {
  ManagementAgentSummary,
  ManagementIssueSummary,
  ManagementProjectSummary,
} from "@paperclipai/shared";
import {
  CROSS_COMPANY_DELEGATION_ORIGIN_KIND,
  managementAnalyzerSnapshotQuerySchema,
  managementDelegatedIssueCreateSchema,
  managementIssueListQuerySchema,
  managementRunListQuerySchema,
} from "@paperclipai/shared";
import {
  accessService,
  crossCompanyAgentGrantService,
  issueService,
  logActivity,
  managementService,
} from "../services/index.js";
import { assertAuthenticated, assertBoardOrAgent, getActorInfo } from "./authz.js";

export function managementRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const management = managementService(db);
  const issues = issueService(db);
  const crossCompanyGrants = crossCompanyAgentGrantService(db);

  async function companyReadAllowed(req: Request, companyId: string) {
    return access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
  }

  function isCrossCompanyGrantRead(decision: Awaited<ReturnType<typeof companyReadAllowed>>) {
    return decision.allowed && Boolean(decision.crossCompanyGrant);
  }

  async function assertCompanyReadAllowed(req: Request, res: Response, companyId: string) {
    const decision = await companyReadAllowed(req, companyId);
    if (decision.allowed) return decision;
    res.status(403).json({ error: "Company is outside this actor's management read boundary" });
    return null;
  }

  async function logCrossCompanyAnalyzerRead(params: {
    req: Request;
    companyId: string;
    decision: Awaited<ReturnType<typeof companyReadAllowed>>;
    windowHours: number;
    evidenceLimit: number;
    excerptPolicy: "full" | "redacted";
  }) {
    if (!params.decision.allowed || !params.decision.crossCompanyGrant) return;
    const actor = getActorInfo(params.req);
    const details = {
      sourceCompanyId: params.decision.crossCompanyGrant.sourceCompanyId,
      targetCompanyId: params.companyId,
      grantId: params.decision.crossCompanyGrant.id,
      capability: params.decision.crossCompanyGrant.capability,
      windowHours: params.windowHours,
      evidenceLimit: params.evidenceLimit,
      excerptPolicy: params.excerptPolicy,
      path: params.req.originalUrl,
    };
    await logActivity(db, {
      companyId: params.decision.crossCompanyGrant.sourceCompanyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "cross_company_analyzer_snapshot.read",
      entityType: "company",
      entityId: params.companyId,
      details,
    });
    await logActivity(db, {
      companyId: params.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "cross_company_analyzer_snapshot.read",
      entityType: "company",
      entityId: params.companyId,
      details,
    });
  }

  async function listAccessibleCompanyIds(req: Request) {
    const rows = await db.select({ id: companies.id }).from(companies);
    const decisions = await Promise.all(rows.map((row) => companyReadAllowed(req, row.id)));
    return rows.filter((_, index) => decisions[index]?.allowed).map((row) => row.id);
  }

  async function filterIssuesForActor(req: Request, rows: ManagementIssueSummary[]) {
    const decisions = await Promise.all(rows.map((issue) => access.decide({
      actor: req.actor,
      action: "issue:read",
      resource: {
        type: "issue",
        companyId: issue.companyId,
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        status: issue.status,
      },
    })));
    return rows.filter((_, index) => decisions[index]?.allowed);
  }

  async function filterAgentsForActor(req: Request, rows: ManagementAgentSummary[]) {
    const decisions = await Promise.all(rows.map((agent) => access.decide({
      actor: req.actor,
      action: "agent:read",
      resource: { type: "agent", companyId: agent.companyId, agentId: agent.id },
    })));
    return rows.filter((_, index) => decisions[index]?.allowed);
  }

  async function filterProjectsForActor(req: Request, rows: ManagementProjectSummary[]) {
    const decisions = await Promise.all(rows.map((project) => access.decide({
      actor: req.actor,
      action: "project:read",
      resource: { type: "project", companyId: project.companyId, projectId: project.id },
    })));
    return rows.filter((_, index) => decisions[index]?.allowed);
  }

  router.get("/management/companies", async (req, res) => {
    assertBoardOrAgent(req);
    const companyIds = await listAccessibleCompanyIds(req);
    const summaries = await management.listCompanySummaries(companyIds);
    res.json({ companies: summaries });
  });

  router.get("/management/companies/:companyId", async (req, res) => {
    assertBoardOrAgent(req);
    const companyId = req.params.companyId as string;
    const decision = await assertCompanyReadAllowed(req, res, companyId);
    if (!decision) return;

    const detail = await management.getCompanyDetail(companyId, {
      includeApprovals: !isCrossCompanyGrantRead(decision),
    });
    if (!detail) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    detail.agents = await filterAgentsForActor(req, detail.agents);
    detail.projects = await filterProjectsForActor(req, detail.projects);
    res.json(detail);
  });

  router.get("/management/companies/:companyId/issues", async (req, res) => {
    assertBoardOrAgent(req);
    const companyId = req.params.companyId as string;
    if (!(await assertCompanyReadAllowed(req, res, companyId))) return;

    const query = managementIssueListQuerySchema.parse(req.query);
    const result = await management.listCompanyIssues(companyId, query);
    res.json({
      issues: await filterIssuesForActor(req, result.issues),
      nextOffset: result.nextOffset,
    });
  });

  router.get("/management/companies/:companyId/analyzer-snapshot", async (req, res) => {
    assertBoardOrAgent(req);
    const companyId = req.params.companyId as string;
    const decision = await assertCompanyReadAllowed(req, res, companyId);
    if (!decision) return;

    const query = managementAnalyzerSnapshotQuerySchema.parse(req.query);
    const access = {
      mode: isCrossCompanyGrantRead(decision) ? "cross_company_grant" : "same_company",
      excerptPolicy: isCrossCompanyGrantRead(decision) ? "redacted" : "full",
      grantId: decision.crossCompanyGrant?.id ?? null,
    } as const;
    const snapshot = await management.getCompanyAnalyzerSnapshot(companyId, {
      windowHours: query.windowHours,
      evidenceLimit: query.evidenceLimit,
      access,
    });
    if (!snapshot) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    await logCrossCompanyAnalyzerRead({
      req,
      companyId,
      decision,
      windowHours: query.windowHours,
      evidenceLimit: query.evidenceLimit,
      excerptPolicy: access.excerptPolicy,
    });

    res.json(snapshot);
  });

  router.get("/management/companies/:companyId/runs", async (req, res) => {
    assertBoardOrAgent(req);
    const companyId = req.params.companyId as string;
    const decision = await assertCompanyReadAllowed(req, res, companyId);
    if (!decision) return;
    if (isCrossCompanyGrantRead(decision)) {
      res.status(403).json({ error: "Heartbeat runs are outside this actor's management read boundary" });
      return;
    }

    const query = managementRunListQuerySchema.parse(req.query);
    res.json(await management.listCompanyRuns(companyId, query));
  });

  // Audited cross-organization delegation. AGENT-ONLY: this is for source-company
  // agents/routines (e.g. TWX CEO/ops) that hold an active "delegate" cross-company
  // grant; same-company agents may also use it but are authorized through the SAME
  // scoped assignment checks as normal issue creation (see issue:delegate in
  // authorization.ts) — not a bypass. Board/instance-admin callers are intentionally
  // not supported here (issue:delegate has no board authorization path); admins use
  // the normal issue APIs. It creates a single bounded issue in the target company
  // and assigns it to that company's CEO (default) or a specified active agent there.
  // It never edits existing target-company issues, instructions, or config — only
  // files new work with a clear owner and a two-company audit.
  router.post("/management/companies/:companyId/delegated-issues", async (req, res) => {
    assertAuthenticated(req);
    if (req.actor.type !== "agent") {
      res.status(403).json({ error: "Issue delegation is available to agents only" });
      return;
    }
    const companyId = req.params.companyId as string;
    const body = managementDelegatedIssueCreateSchema.parse(req.body);

    // Validate the optional project belongs to the target company.
    if (body.projectId) {
      const project = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, body.projectId), eq(projects.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!project) {
        res.status(404).json({ error: "Project not found in target company" });
        return;
      }
    }

    // Resolve the assignee inside the target company BEFORE authorizing, so the
    // authorization decision sees the full assignment scope (project + assignee)
    // and applies the same boundary/policy/low-trust checks as a normal assign.
    // Explicit assignee is further validated by issueService.create; omitted →
    // the target company's CEO agent.
    let assigneeAgentId = body.assigneeAgentId ?? null;
    if (!assigneeAgentId) {
      const ceo = await db
        .select({ id: agents.id, status: agents.status })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")))
        .then((rows) => rows.find((row) => row.status !== "terminated") ?? rows[0] ?? null);
      if (!ceo) {
        res.status(422).json({
          error: "Target company has no CEO agent; specify an explicit assigneeAgentId",
        });
        return;
      }
      assigneeAgentId = ceo.id;
    }

    const decision = await access.decide({
      actor: req.actor,
      action: "issue:delegate",
      resource: {
        type: "issue",
        companyId,
        projectId: body.projectId ?? null,
        assigneeAgentId,
        parentIssueId: null,
        status: "todo",
      },
    });
    if (!decision.allowed) {
      // Generic: the denial may be a missing cross-company delegate grant OR a
      // same-company low-trust / assignment-policy boundary.
      res.status(403).json({ error: "Issue delegation is outside this actor's boundary" });
      return;
    }

    const actor = getActorInfo(req);
    const sourceCompanyId = decision.crossCompanyGrant?.sourceCompanyId ?? req.actor.companyId ?? null;
    const grantId = decision.crossCompanyGrant?.id ?? null;
    const isCrossCompany = Boolean(decision.crossCompanyGrant);

    // For cross-company delegation, atomically reserve one use of the grant
    // BEFORE creating the issue. This closes the window where two concurrent
    // delegations both pass the authorization gate and then both create an issue,
    // which would exceed maxUses. The reservation re-checks expiry/quota under a
    // guarded UPDATE, so a grant exhausted or expired between the authorization
    // read and now is correctly denied here (TWX-1036). Same-company delegation
    // has no grant and skips this.
    let reservedUsage: Awaited<ReturnType<typeof crossCompanyGrants.recordUse>> | null = null;
    if (isCrossCompany && grantId) {
      reservedUsage = await crossCompanyGrants.recordUse(grantId);
      if (!reservedUsage) {
        res.status(403).json({
          error: "Cross-company delegation grant is expired or has reached its usage limit",
        });
        return;
      }
    }

    let created;
    try {
      created = await issues.create(companyId, {
        id: randomUUID(),
        title: body.title,
        description: body.description ?? null,
        priority: body.priority,
        status: "todo",
        assigneeAgentId,
        projectId: body.projectId ?? null,
        // Only cross-company delegations carry the cross-company provenance so
        // same-company delegated issues are not conflated with true cross-org
        // ones in origin-based reporting/audit. Same-company use is still
        // captured by the issue.delegated activity-log entry below.
        originKind: isCrossCompany ? CROSS_COMPANY_DELEGATION_ORIGIN_KIND : undefined,
        originId: isCrossCompany ? sourceCompanyId : undefined,
        originRunId: actor.runId,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
    } catch (err: any) {
      const status = typeof err?.status === "number" ? err.status : 422;
      res.status(status).json({ error: err?.message ?? "Could not create delegated issue" });
      return;
    }

    // Audit is best-effort: the issue (created transactionally above) is the
    // source of truth. A logging failure must NOT 500 the request, because that
    // would invite a client retry that creates a duplicate issue. We record the
    // delegation in both companies for cross-company delegation, or once for a
    // same-company delegation.
    const auditAction = isCrossCompany ? "cross_company_issue.delegated" : "issue.delegated";
    const auditDetails = {
      sourceCompanyId,
      targetCompanyId: companyId,
      grantId,
      mode: isCrossCompany ? "cross_company_grant" : "same_company",
      grantUsedCount: reservedUsage?.usedCount ?? null,
      grantMaxUses: reservedUsage?.maxUses ?? null,
      issueId: created.id,
      identifier: created.identifier,
      assigneeAgentId,
      title: created.title,
      path: req.originalUrl,
    };
    const auditCompanyIds = isCrossCompany && sourceCompanyId
      ? [sourceCompanyId, companyId]
      : [companyId];
    for (const auditCompanyId of auditCompanyIds) {
      try {
        await logActivity(db, {
          companyId: auditCompanyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: auditAction,
          entityType: "issue",
          entityId: created.id,
          details: auditDetails,
        });
      } catch (err) {
        console.error(
          `[delegated-issues] audit log failed for company ${auditCompanyId}, issue ${created.id}`,
          err,
        );
      }
    }

    res.status(201).json({
      issue: {
        id: created.id,
        identifier: created.identifier,
        companyId: created.companyId,
        title: created.title,
        status: created.status,
        priority: created.priority,
        assigneeAgentId: created.assigneeAgentId,
        projectId: created.projectId,
      },
      access: {
        mode: isCrossCompany ? "cross_company_grant" : "same_company",
        grantId,
        sourceCompanyId,
        grantUsedCount: reservedUsage?.usedCount ?? null,
        grantMaxUses: reservedUsage?.maxUses ?? null,
      },
    });
  });

  return router;
}
