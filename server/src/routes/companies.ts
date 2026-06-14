import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { agents as agentsTable, authUsers, companyMemberships, issues as issuesTable } from "@paperclipai/db";
import { and, count, eq, isNotNull } from "drizzle-orm";
import {
  DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION,
  companyPortabilityExportSchema,
  companyPortabilityImportSchema,
  companyPortabilityPreviewSchema,
  createCompanySchema,
  feedbackTargetTypeSchema,
  feedbackTraceStatusSchema,
  feedbackVoteValueSchema,
  updateCompanyBrandingSchema,
  updateCompanySchema,
} from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  budgetService,
  companyPortabilityService,
  companyService,
  feedbackService,
  logActivity,
} from "../services/index.js";
import type { StorageService } from "../storage/types.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";
import { COMPANY_IMPORT_ROUTE_PATH } from "./company-import-paths.js";

export function companyRoutes(db: Db, storage?: StorageService) {
  const router = Router();
  const svc = companyService(db);
  const agents = agentService(db);
  const portability = companyPortabilityService(db, storage);
  const access = accessService(db);
  const budgets = budgetService(db);
  const feedback = feedbackService(db);
  const importJobs = new Map<string, ImportJobRecord>();
  const importJobTerminalRetentionMs = 5 * 60 * 1000;

  function parseBooleanQuery(value: unknown) {
    return value === true || value === "true" || value === "1";
  }

  function parseDateQuery(value: unknown, field: string) {
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw badRequest(`Invalid ${field} query value`);
    }
    return parsed;
  }

  function assertImportTargetAccess(
    req: Request,
    target: { mode: "new_company" } | { mode: "existing_company"; companyId: string },
  ) {
    if (target.mode === "new_company") {
      assertInstanceAdmin(req);
      return;
    }
    assertCompanyAccess(req, target.companyId);
  }

  async function assertCanUpdateBranding(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actorAgent.role !== "ceo") {
      throw forbidden("Only CEO agents can update company branding");
    }
  }

  async function assertCanManagePortability(req: Request, companyId: string, capability: "imports" | "exports") {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actorAgent.role !== "ceo") {
      throw forbidden(`Only CEO agents can manage company ${capability}`);
    }
  }

  router.get("/", async (req, res) => {
    assertBoard(req);
    const result = await svc.list();
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
      res.json(result);
      return;
    }
    const allowed = new Set(req.actor.companyIds ?? []);
    res.json(result.filter((company) => allowed.has(company.id)));
  });

  router.get("/stats", async (req, res) => {
    assertBoard(req);
    const allowed = req.actor.source === "local_implicit" || req.actor.isInstanceAdmin
      ? null
      : new Set(req.actor.companyIds ?? []);
    const stats = await svc.stats();
    if (!allowed) {
      res.json(stats);
      return;
    }
    const filtered = Object.fromEntries(Object.entries(stats).filter(([companyId]) => allowed.has(companyId)));
    res.json(filtered);
  });

  // Common malformed path when companyId is empty in "/api/companies/{companyId}/issues".
  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });

  router.get("/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    // Allow agents (CEO) to read their own company; board always allowed
    if (req.actor.type !== "agent") {
      assertBoard(req);
    }
    const company = await svc.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(company);
  });

  router.get("/:companyId/feedback-traces", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const targetTypeRaw = typeof req.query.targetType === "string" ? req.query.targetType : undefined;
    const voteRaw = typeof req.query.vote === "string" ? req.query.vote : undefined;
    const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
    const issueId = typeof req.query.issueId === "string" && req.query.issueId.trim().length > 0 ? req.query.issueId : undefined;
    const projectId = typeof req.query.projectId === "string" && req.query.projectId.trim().length > 0
      ? req.query.projectId
      : undefined;

    const traces = await feedback.listFeedbackTraces({
      companyId,
      issueId,
      projectId,
      targetType: targetTypeRaw ? feedbackTargetTypeSchema.parse(targetTypeRaw) : undefined,
      vote: voteRaw ? feedbackVoteValueSchema.parse(voteRaw) : undefined,
      status: statusRaw ? feedbackTraceStatusSchema.parse(statusRaw) : undefined,
      from: parseDateQuery(req.query.from, "from"),
      to: parseDateQuery(req.query.to, "to"),
      sharedOnly: parseBooleanQuery(req.query.sharedOnly),
      includePayload: parseBooleanQuery(req.query.includePayload),
    });
    res.json(traces);
  });

  router.post("/:companyId/export", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "exports");
    const result = await portability.exportBundle(companyId, req.body);
    res.json(result);
  });

  router.post("/import/preview", validate(companyPortabilityPreviewSchema), async (req, res) => {
    assertBoard(req);
    assertImportTargetAccess(req, req.body.target);
    const preview = await portability.previewImport(req.body);
    res.json(preview);
  });

  router.get("/import/jobs/:jobId", async (req, res) => {
    assertCloudTenantCaller(req);
    cleanupTerminalImportJobs(importJobs, importJobTerminalRetentionMs);
    const job = importJobs.get(req.params.jobId as string);
    if (!job || job.cloudTenantKey !== cloudTenantRequestKey(req)) {
      res.status(404).json({ error: "Import job not found" });
      return;
    }
    res.json(importJobResponse(job));
  });

  router.post(COMPANY_IMPORT_ROUTE_PATH, async (req, res) => {
    assertBoard(req);
    const rawImportBody: unknown = req.body;
    const actor = getActorInfo(req);
    const boardUserId = req.actor.type === "board" ? req.actor.userId : null;
    if (req.header("x-paperclip-cloud-async-import") === "1") {
      assertCloudTenantCaller(req);
      cleanupTerminalImportJobs(importJobs, importJobTerminalRetentionMs);
      const job = createImportJob(cloudTenantRequestKey(req));
      importJobs.set(job.id, job);
      const operation = async () => {
        const importBody = companyPortabilityImportSchema.parse(rawImportBody);
        assertImportTargetAccess(req, importBody.target);
        const activity = importedCompanyActivityContext(actor, importBody.include ?? null);
        const result = await portability.importBundle(importBody, boardUserId);
        await logImportedCompanyActivity(db, activity, result);
        return result;
      };
      res.status(202).json(importJobAcceptedResponse(job));
      setImmediate(() => {
        void runImportJob(job, operation);
      });
      return;
    }

    const importBody = companyPortabilityImportSchema.parse(rawImportBody);
    assertImportTargetAccess(req, importBody.target);
    const activity = importedCompanyActivityContext(actor, importBody.include ?? null);
    const result = await portability.importBundle(importBody, boardUserId);
    await logImportedCompanyActivity(db, activity, result);
    res.json(result);
  });

  router.post("/:companyId/exports/preview", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "exports");
    const preview = await portability.previewExport(companyId, req.body);
    res.json(preview);
  });

  router.post("/:companyId/exports", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "exports");
    const result = await portability.exportBundle(companyId, req.body);
    res.json(result);
  });

  router.post("/:companyId/imports/preview", validate(companyPortabilityPreviewSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "imports");
    if (req.body.target.mode === "existing_company" && req.body.target.companyId !== companyId) {
      throw forbidden("Safe import route can only target the route company");
    }
    if (req.body.collisionStrategy === "replace") {
      throw forbidden("Safe import route does not allow replace collision strategy");
    }
    const preview = await portability.previewImport(req.body, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    res.json(preview);
  });

  router.post("/:companyId/imports/apply", validate(companyPortabilityImportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "imports");
    if (req.body.target.mode === "existing_company" && req.body.target.companyId !== companyId) {
      throw forbidden("Safe import route can only target the route company");
    }
    if (req.body.collisionStrategy === "replace") {
      throw forbidden("Safe import route does not allow replace collision strategy");
    }
    const actor = getActorInfo(req);
    const result = await portability.importBundle(req.body, req.actor.type === "board" ? req.actor.userId : null, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    await logActivity(db, {
      companyId: result.company.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      entityType: "company",
      entityId: result.company.id,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.imported",
      details: {
        include: req.body.include ?? null,
        agentCount: result.agents.length,
        warningCount: result.warnings.length,
        companyAction: result.company.action,
        importMode: "agent_safe",
      },
    });
    res.json(result);
  });

  router.post("/", validate(createCompanySchema), async (req, res) => {
    assertBoard(req);
    if (!(req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)) {
      throw forbidden("Instance admin required");
    }
    const company = await svc.create(req.body);
    const ownerPrincipalId = req.actor.userId ?? "local-board";
    await access.ensureMembership(company.id, "user", ownerPrincipalId, "owner", "active");
    await access.ensureRoleDefaultGrants(
      company.id,
      ownerPrincipalId,
      "owner",
      req.actor.userId ?? null,
    );
    await logActivity(db, {
      companyId: company.id,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.created",
      entityType: "company",
      entityId: company.id,
      details: { name: company.name },
    });
    if (company.budgetMonthlyCents > 0) {
      await budgets.upsertPolicy(
        company.id,
        {
          scopeType: "company",
          scopeId: company.id,
          amount: company.budgetMonthlyCents,
          windowKind: "calendar_month_utc",
        },
        req.actor.userId ?? "board",
      );
    }
    res.status(201).json(company);
  });

  router.patch("/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const actor = getActorInfo(req);
    const existingCompany = await svc.getById(companyId);
    if (!existingCompany) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    let body: Record<string, unknown>;

    if (req.actor.type === "agent") {
      // Only CEO agents may update company branding fields
      const agentSvc = agentService(db);
      const actorAgent = req.actor.agentId ? await agentSvc.getById(req.actor.agentId) : null;
      if (!actorAgent || actorAgent.role !== "ceo") {
        throw forbidden("Only CEO agents or board users may update company settings");
      }
      if (actorAgent.companyId !== companyId) {
        throw forbidden("Agent key cannot access another company");
      }
      body = updateCompanyBrandingSchema.parse(req.body);
    } else {
      assertBoard(req);
      body = updateCompanySchema.parse(req.body);

      if (body.feedbackDataSharingEnabled === true && !existingCompany.feedbackDataSharingEnabled) {
        body = {
          ...body,
          feedbackDataSharingConsentAt: new Date(),
          feedbackDataSharingConsentByUserId: req.actor.userId ?? "local-board",
          feedbackDataSharingTermsVersion:
            typeof body.feedbackDataSharingTermsVersion === "string" && body.feedbackDataSharingTermsVersion.length > 0
              ? body.feedbackDataSharingTermsVersion
              : DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION,
        };
      }
    }

    const company = await svc.update(companyId, body);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.updated",
      entityType: "company",
      entityId: companyId,
      details: body,
    });
    res.json(company);
  });

  router.patch("/:companyId/branding", validate(updateCompanyBrandingSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanUpdateBranding(req, companyId);
    const company = await svc.update(companyId, req.body);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.branding_updated",
      entityType: "company",
      entityId: companyId,
      details: req.body,
    });
    res.json(company);
  });

  router.post("/:companyId/archive", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const company = await svc.archive(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.archived",
      entityType: "company",
      entityId: companyId,
    });
    res.json(company);
  });

  router.delete("/:companyId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const company = await svc.remove(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json({ ok: true });
  });


  router.get('/:companyId/analytics', async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const [agentRows, issueRows, memberRows, telemetryLinkedRows] = await Promise.all([
      db.select({ cnt: count() }).from(agentsTable).where(eq(agentsTable.companyId, companyId)),
      db.select({ cnt: count() }).from(issuesTable).where(eq(issuesTable.companyId, companyId)),
      db.select({ cnt: count() }).from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, 'user'))),
      db.select({ cnt: count() }).from(authUsers).innerJoin(companyMemberships, eq(authUsers.id, companyMemberships.principalId)).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, 'user'), isNotNull(authUsers.telemetryId))),
    ]);

    res.json({
      agentCount: Number(agentRows[0]?.cnt ?? 0),
      issueCount: Number(issueRows[0]?.cnt ?? 0),
      userCount: Number(memberRows[0]?.cnt ?? 0),
      telemetryLinkedUserCount: Number(telemetryLinkedRows[0]?.cnt ?? 0),
    });
  });

  return router;
}

type CompanyImportResult = {
  company: { id: string; action: unknown };
  agents: unknown[];
  warnings: unknown[];
};

interface ImportJobRecord {
  id: string;
  cloudTenantKey: string;
  status: "running" | "succeeded" | "failed";
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: { message: string };
  result?: {
    companyId: string;
    agentCount: number;
    warningCount: number;
    companyAction: unknown;
  };
}

interface ImportedCompanyActivityContext {
  actorType: "user" | "agent";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  include: unknown;
}

function assertCloudTenantCaller(req: Request) {
  if (req.actor.source !== "cloud_tenant") {
    throw forbidden("Trusted Cloud tenant access required");
  }
}

function cloudTenantRequestKey(req: Request) {
  return [
    req.actor.userId ?? "",
    req.header("x-paperclip-cloud-stack-id")?.trim() ?? "",
    req.header("x-paperclip-cloud-paperclip-company-id")?.trim() ?? "",
  ].join(":");
}

function createImportJob(cloudTenantKey: string): ImportJobRecord {
  const now = new Date().toISOString();
  return {
    id: `tenant-import-${randomUUID()}`,
    cloudTenantKey,
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
}

async function runImportJob(
  job: ImportJobRecord,
  operation: () => Promise<CompanyImportResult>,
) {
  try {
    const result = await operation();
    const now = new Date().toISOString();
    job.status = "succeeded";
    job.updatedAt = now;
    job.completedAt = now;
    job.result = {
      companyId: result.company.id,
      agentCount: result.agents.length,
      warningCount: result.warnings.length,
      companyAction: result.company.action,
    };
  } catch (error) {
    const now = new Date().toISOString();
    job.status = "failed";
    job.updatedAt = now;
    job.completedAt = now;
    job.error = { message: errorMessage(error) };
  }
}

function importedCompanyActivityContext(
  actor: ReturnType<typeof getActorInfo>,
  include: unknown,
): ImportedCompanyActivityContext {
  return {
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    runId: actor.runId,
    include,
  };
}

async function logImportedCompanyActivity(
  db: Db,
  activity: ImportedCompanyActivityContext,
  result: CompanyImportResult,
) {
  await logActivity(db, {
    companyId: result.company.id,
    actorType: activity.actorType,
    actorId: activity.actorId,
    action: "company.imported",
    entityType: "company",
    entityId: result.company.id,
    agentId: activity.agentId,
    runId: activity.runId,
    details: {
      include: activity.include,
      agentCount: result.agents.length,
      warningCount: result.warnings.length,
      companyAction: result.company.action,
    },
  });
}

function importJobAcceptedResponse(job: ImportJobRecord) {
  return {
    job: {
      id: job.id,
      status: job.status,
    },
    statusUrl: `/api/companies/import/jobs/${encodeURIComponent(job.id)}`,
    retryAfterMs: 1000,
  };
}

function importJobResponse(job: ImportJobRecord) {
  const isTerminal = job.status === "succeeded" || job.status === "failed";
  const response: Record<string, unknown> = {
    job: {
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      ...(job.completedAt ? { completedAt: job.completedAt } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.result ? { result: job.result } : {}),
    },
    ...(isTerminal ? {} : { retryAfterMs: 1000 }),
  };
  if (job.error?.message) {
    response.error = job.error.message;
    response.message = job.error.message;
    response.reason = job.error.message;
  }
  return response;
}

function cleanupTerminalImportJobs(importJobs: Map<string, ImportJobRecord>, terminalRetentionMs: number) {
  const now = Date.now();
  for (const [jobId, job] of importJobs) {
    if (job.status === "running" || !job.completedAt) continue;
    if (now - Date.parse(job.completedAt) > terminalRetentionMs) {
      importJobs.delete(jobId);
    }
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}
