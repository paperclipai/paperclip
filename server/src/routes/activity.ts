import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { normalizeIssueIdentifier } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { activityService, normalizeActivityLimit } from "../services/activity.js";
import { assertAuthenticated, assertBoard, assertCompanyAccess, getAccessibleResource, hasCompanyAccess } from "./authz.js";
import { accessService, heartbeatService, issueService } from "../services/index.js";
import { sanitizeRecord } from "../redaction.js";
import { badRequest, forbidden } from "../errors.js";
import { agentActionAuditService } from "../services/agent-action-audit.js";
import { logActivity } from "../services/activity-log.js";

/** Max rows a single CSV export will stream (guards against runaway exports). */
const AUDIT_CSV_EXPORT_MAX_ROWS = 10_000;
const AUDIT_CSV_PAGE_SIZE = 200;

const AUDIT_CSV_COLUMNS = [
  "createdAt",
  "action",
  "actorType",
  "actorId",
  "agentId",
  "runId",
  "responsibleUserId",
  "entityType",
  "entityId",
  "issueIdentifier",
  "issueTitle",
  "commentExcerpt",
  "documentKey",
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = value instanceof Date ? value.toISOString() : String(value);
  // Quote if the value contains a delimiter, quote, or newline; escape quotes by doubling.
  return /[",\r\n]/.test(str) ? `"${str.replaceAll('"', '""')}"` : str;
}

function readNested(value: unknown, ...keys: string[]): string | null {
  let cursor: unknown = value;
  for (const key of keys) {
    if (!cursor || typeof cursor !== "object") return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "string" ? cursor : null;
}

type AuditCsvRow = {
  createdAt: Date | string;
  action: string;
  actorType: string | null;
  actorId: string | null;
  agentId: string | null;
  runId: string | null;
  responsibleUserId: string | null;
  entityType: string;
  entityId: string;
  // Enrichment snippet is redacted server-side into a plain record, so read it
  // defensively rather than assuming a fixed shape.
  entity: unknown;
};

function auditRowsToCsv(rows: AuditCsvRow[]): string {
  const lines = [AUDIT_CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push([
      csvCell(row.createdAt),
      csvCell(row.action),
      csvCell(row.actorType),
      csvCell(row.actorId),
      csvCell(row.agentId),
      csvCell(row.runId),
      csvCell(row.responsibleUserId),
      csvCell(row.entityType),
      csvCell(row.entityId),
      csvCell(readNested(row.entity, "issue", "identifier")),
      csvCell(readNested(row.entity, "issue", "title")),
      csvCell(readNested(row.entity, "comment", "excerpt")),
      csvCell(readNested(row.entity, "document", "key")),
    ].join(","));
  }
  // Trailing newline keeps POSIX tools + spreadsheet importers happy.
  return `${lines.join("\r\n")}\r\n`;
}

const createActivitySchema = z.object({
  actorType: z.enum(["agent", "user", "system", "plugin"]).optional().default("system"),
  actorId: z.string().min(1),
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  agentId: z.string().uuid().optional().nullable(),
  details: z.record(z.unknown()).optional().nullable(),
});

const agentActionAuditQuerySchema = z.object({
  agentId: z.string().uuid().optional(),
  responsibleUserId: z.string().min(1).optional(),
  runId: z.string().uuid().optional(),
  entityType: z.string().min(1).optional(),
  entityId: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  actorType: z.enum(["agent", "user", "system", "plugin"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function activityRoutes(db: Db) {
  const router = Router();
  const svc = activityService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db);
  const issueSvc = issueService(db);
  const agentAudit = agentActionAuditService(db);

  async function assertAgentAuditPermission(req: import("express").Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    if (req.actor.userId && await access.canUser(companyId, req.actor.userId, "audit:view_agent_actions")) return;
    throw forbidden("Missing permission: audit:view_agent_actions");
  }

  async function assertCompanyScopeReadAllowed(req: Parameters<typeof assertCompanyAccess>[0], res: any, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Activity is outside this actor's authorization boundary" });
    return false;
  }

  async function assertIssueReadAllowed(req: Parameters<typeof assertCompanyAccess>[0], res: any, issue: {
    id: string;
    companyId: string;
    projectId: string | null;
    parentId: string | null;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
    status: string;
  }) {
    const decision = await access.decide({
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
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Issue activity is outside this actor's authorization boundary" });
    return false;
  }

  async function resolveIssueByRef(rawId: string) {
    const identifier = normalizeIssueIdentifier(rawId);
    if (identifier) {
      return issueSvc.getByIdentifier(identifier);
    }
    return issueSvc.getById(rawId);
  }

  router.get("/companies/:companyId/activity", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyScopeReadAllowed(req, res, companyId))) return;

    const filters = {
      companyId,
      agentId: req.query.agentId as string | undefined,
      entityType: req.query.entityType as string | undefined,
      entityId: req.query.entityId as string | undefined,
      limit: normalizeActivityLimit(Number(req.query.limit)),
    };
    const result = await svc.list(filters);
    res.json(result);
  });

  router.get("/companies/:companyId/audit/agent-actions", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertAgentAuditPermission(req, companyId);
    const parsedQuery = agentActionAuditQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      throw badRequest("Invalid agent action audit query", parsedQuery.error.issues);
    }
    res.json(await agentAudit.list({ companyId, ...parsedQuery.data }));
  });

  router.get("/companies/:companyId/audit/agent-actions.csv", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertAgentAuditPermission(req, companyId);
    const parsedQuery = agentActionAuditQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      throw badRequest("Invalid agent action audit query", parsedQuery.error.issues);
    }
    // Drive our own pagination for the export; a client-supplied cursor/limit
    // would silently truncate the export, so ignore them.
    const { cursor: _cursor, limit: _limit, ...filters } = parsedQuery.data;
    const rows: Awaited<ReturnType<typeof agentAudit.list>>["items"] = [];
    let cursor: string | undefined;
    do {
      const page = await agentAudit.list({ companyId, ...filters, cursor, limit: AUDIT_CSV_PAGE_SIZE });
      for (const item of page.items) {
        if (rows.length >= AUDIT_CSV_EXPORT_MAX_ROWS) break;
        rows.push(item);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor && rows.length < AUDIT_CSV_EXPORT_MAX_ROWS);

    // The export is itself an auditable act (training-data export precedent):
    // record who exported what filter set and how many rows left the system.
    const actorUserId = req.actor.type === "board" ? req.actor.userId ?? null : null;
    await logActivity(db, {
      companyId,
      actorType: actorUserId ? "user" : "system",
      actorId: actorUserId ?? "local-board",
      action: "audit.exported",
      entityType: "company",
      entityId: companyId,
      details: {
        format: "csv",
        rowCount: rows.length,
        truncated: rows.length >= AUDIT_CSV_EXPORT_MAX_ROWS,
        filters: {
          agentId: filters.agentId ?? null,
          responsibleUserId: filters.responsibleUserId ?? null,
          runId: filters.runId ?? null,
          entityType: filters.entityType ?? null,
          entityId: filters.entityId ?? null,
          action: filters.action ?? null,
          actorType: filters.actorType ?? null,
          from: filters.from ? filters.from.toISOString() : null,
          to: filters.to ? filters.to.toISOString() : null,
        },
      },
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="agent-audit-${companyId}.csv"`);
    res.send(auditRowsToCsv(rows));
  });

  router.post("/companies/:companyId/activity", validate(createActivitySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const event = await svc.create({
      companyId,
      ...req.body,
      details: req.body.details ? sanitizeRecord(req.body.details) : null,
    });
    res.status(201).json(event);
  });

  router.get("/issues/:id/activity", async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await getAccessibleResource(req, res, resolveIssueByRef(rawId), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const result = await svc.forIssue(issue.id);
    res.json(result);
  });

  router.get("/issues/:id/runs", async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await getAccessibleResource(req, res, resolveIssueByRef(rawId), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const result = await svc.runsForIssue(issue.companyId, issue.id);
    res.json(result);
  });

  router.get("/heartbeat-runs/:runId/issues", async (req, res) => {
    assertAuthenticated(req);
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run || !hasCompanyAccess(req, run.companyId)) {
      // Return `200 []` for both "doesn't exist" and "cross-tenant" — preserves the
      // legacy API contract while keeping the cross-tenant existence oracle closed
      // (both branches yield indistinguishable responses).
      res.json([]);
      return;
    }
    assertCompanyAccess(req, run.companyId);
    if (!(await assertCompanyScopeReadAllowed(req, res, run.companyId))) return;
    const result = await svc.issuesForRun(runId);
    res.json(result);
  });

  return router;
}
