import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  assets,
  caseAttachments,
  caseDocuments,
  caseEvents,
  caseIssueLinks,
  caseLabels,
  cases,
  companies,
  documents,
  documentRevisions,
  issues,
  labels,
  projects,
} from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { normalizeContentType } from "../attachment-types.js";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import type { StorageService } from "../storage/types.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

type CaseRouteDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type CaseActor = ReturnType<typeof getActorInfo>;

const CASE_STATUSES = ["draft", "in_progress", "in_review", "approved", "done", "cancelled"] as const;
const CASE_LINK_ROLES = ["origin", "work", "reference"] as const;
const DEFAULT_EVENTS_LIMIT = 100;
const MAX_EVENTS_LIMIT = 500;

const jsonObjectSchema = z.record(z.string(), z.unknown());
const caseStatusSchema = z.enum(CASE_STATUSES);
const caseTypeSchema = z.string().trim().min(1).max(120);
const caseKeySchema = z.string().trim().min(1).max(512);
const documentKeySchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/);

const createCaseSchema = z.object({
  projectId: z.string().uuid().nullable().optional(),
  caseType: caseTypeSchema,
  key: caseKeySchema.nullable().optional(),
  title: z.string().trim().min(1).max(500),
  summary: z.string().max(8_000).nullable().optional(),
  status: caseStatusSchema.optional(),
  fields: jsonObjectSchema.optional(),
  parentCaseId: z.string().uuid().nullable().optional(),
}).strict();

const patchCaseSchema = z.object({
  projectId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(500).optional(),
  summary: z.string().max(8_000).nullable().optional(),
  status: caseStatusSchema.optional(),
  fields: jsonObjectSchema.optional(),
  parentCaseId: z.string().uuid().nullable().optional(),
  labels: z.array(z.string().uuid()).max(100).optional(),
  labelIds: z.array(z.string().uuid()).max(100).optional(),
}).strict();

const createIssueLinkSchema = z.object({
  issueId: z.string().uuid(),
  role: z.enum(CASE_LINK_ROLES),
}).strict();

const upsertCaseDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  format: z.string().trim().min(1).max(80).optional().default("markdown"),
  body: z.string().max(200_000),
  changeSummary: z.string().trim().max(1_000).nullable().optional(),
  baseRevisionId: z.string().uuid().nullable().optional(),
}).strict();

const listCasesQuerySchema = z.object({
  type: z.string().trim().min(1).max(120).optional(),
  status: z.string().trim().min(1).max(120).optional(),
  project: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  label: z.string().uuid().optional(),
  labelId: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
}).strict();

const listEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_EVENTS_LIMIT).optional().default(DEFAULT_EVENTS_LIMIT),
}).strict();

function eventActorValues(actor: CaseActor) {
  return {
    actorType: actor.actorType,
    actorUserId: actor.actorType === "user" ? actor.actorId : null,
    actorAgentId: actor.agentId,
    runId: actor.runId && isUuidLike(actor.runId) ? actor.runId : null,
  };
}

async function assertCasesEnabled(db: Db) {
  const experimental = await instanceSettingsService(db).getExperimental();
  if (!experimental.enableCases) {
    throw forbidden("Cases are disabled");
  }
}

function parseDocumentKey(raw: string | undefined) {
  const parsed = documentKeySchema.safeParse(raw);
  if (!parsed.success) throw badRequest("Invalid document key", parsed.error.issues);
  return parsed.data;
}

async function loadCaseByIdOrIdentifier(db: CaseRouteDb, idOrIdentifier: string) {
  const normalizedIdentifier = idOrIdentifier.trim().toUpperCase();
  const where = isUuidLike(idOrIdentifier)
    ? or(eq(cases.id, idOrIdentifier), eq(cases.identifier, normalizedIdentifier))
    : eq(cases.identifier, normalizedIdentifier);
  return db.select().from(cases).where(where).limit(1).then((rows) => rows[0] ?? null);
}

async function assertCaseAccess(db: Db, req: Request, idOrIdentifier: string) {
  const row = await loadCaseByIdOrIdentifier(db, idOrIdentifier);
  if (!row) throw notFound("Case not found");
  assertCompanyAccess(req, row.companyId);
  return row;
}

async function assertProjectBelongsToCompany(db: CaseRouteDb, input: { companyId: string; projectId: string | null }) {
  if (!input.projectId) return;
  const row = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.companyId, input.companyId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) throw unprocessable("Project does not belong to company");
}

async function assertParentCaseBelongsToCompany(db: CaseRouteDb, input: {
  companyId: string;
  caseId?: string;
  parentCaseId: string | null;
}) {
  if (!input.parentCaseId) return;
  if (input.caseId && input.parentCaseId === input.caseId) {
    throw unprocessable("A case cannot be its own parent");
  }
  const row = await db
    .select({ id: cases.id })
    .from(cases)
    .where(and(eq(cases.id, input.parentCaseId), eq(cases.companyId, input.companyId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) throw unprocessable("Parent case does not belong to company");
}

async function assertLabelsBelongToCompany(db: CaseRouteDb, companyId: string, labelIds: string[]) {
  if (labelIds.length === 0) return;
  const uniqueIds = [...new Set(labelIds)];
  const rows = await db
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.companyId, companyId), inArray(labels.id, uniqueIds)));
  if (rows.length !== uniqueIds.length) {
    throw unprocessable("One or more labels do not belong to company");
  }
}

async function insertCaseEvent(db: CaseRouteDb, input: {
  companyId: string;
  caseId: string;
  kind: typeof caseEvents.$inferInsert["kind"];
  actor: CaseActor;
  payload?: Record<string, unknown>;
}) {
  const now = new Date();
  const [event] = await db.insert(caseEvents).values({
    companyId: input.companyId,
    caseId: input.caseId,
    kind: input.kind,
    ...eventActorValues(input.actor),
    payload: input.payload ?? {},
    createdAt: now,
    updatedAt: now,
  }).returning();
  return event!;
}

async function resolveIssueForRun(db: CaseRouteDb, companyId: string, runId: string | null | undefined) {
  if (!runId || !isUuidLike(runId)) return null;
  return db
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      eq(issues.companyId, companyId),
      or(
        eq(issues.executionRunId, runId),
        eq(issues.checkoutRunId, runId),
        eq(issues.originRunId, runId),
      ),
    ))
    .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function autoLinkRunIssue(db: CaseRouteDb, input: {
  companyId: string;
  caseId: string;
  actor: CaseActor;
  role: "origin" | "work";
}) {
  const issue = await resolveIssueForRun(db, input.companyId, input.actor.runId);
  if (!issue) return null;
  const now = new Date();
  const [link] = await db.insert(caseIssueLinks).values({
    companyId: input.companyId,
    caseId: input.caseId,
    issueId: issue.id,
    role: input.role,
    createdByRunId: input.actor.runId && isUuidLike(input.actor.runId) ? input.actor.runId : null,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing({
    target: [caseIssueLinks.caseId, caseIssueLinks.issueId],
  }).returning();
  if (!link) return null;
  await insertCaseEvent(db, {
    companyId: input.companyId,
    caseId: input.caseId,
    kind: "issue_linked",
    actor: input.actor,
    payload: { issueId: issue.id, role: input.role, autoLinked: true },
  });
  return link;
}

async function nextCaseIdentity(db: CaseRouteDb, companyId: string) {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`paperclip:cases:${companyId}`}))`);
  const [company] = await db
    .select({ issuePrefix: companies.issuePrefix })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (!company) throw notFound("Company not found");
  const [maxRow] = await db
    .select({ maxNum: sql<number>`coalesce(max(${cases.caseNumber}), 0)` })
    .from(cases)
    .where(eq(cases.companyId, companyId));
  const caseNumber = (maxRow?.maxNum ?? 0) + 1;
  return {
    caseNumber,
    identifier: `${company.issuePrefix.toUpperCase()}-C${caseNumber}`,
  };
}

function completedAtForStatus(status: string, previous?: Date | null) {
  if (status === "done" || status === "cancelled") return previous ?? new Date();
  return null;
}

async function loadCaseDetail(db: CaseRouteDb, row: typeof cases.$inferSelect) {
  const [labelRows, linkRows, documentRows, attachmentRows] = await Promise.all([
    db
      .select({ label: labels })
      .from(caseLabels)
      .innerJoin(labels, eq(caseLabels.labelId, labels.id))
      .where(and(eq(caseLabels.companyId, row.companyId), eq(caseLabels.caseId, row.id)))
      .orderBy(asc(labels.name)),
    db
      .select({ link: caseIssueLinks, issue: issues })
      .from(caseIssueLinks)
      .innerJoin(issues, eq(caseIssueLinks.issueId, issues.id))
      .where(and(eq(caseIssueLinks.companyId, row.companyId), eq(caseIssueLinks.caseId, row.id)))
      .orderBy(asc(caseIssueLinks.createdAt)),
    db
      .select({ link: caseDocuments, document: documents })
      .from(caseDocuments)
      .innerJoin(documents, eq(caseDocuments.documentId, documents.id))
      .where(and(eq(caseDocuments.companyId, row.companyId), eq(caseDocuments.caseId, row.id)))
      .orderBy(asc(caseDocuments.key)),
    db
      .select({ link: caseAttachments, asset: assets })
      .from(caseAttachments)
      .innerJoin(assets, eq(caseAttachments.assetId, assets.id))
      .where(and(eq(caseAttachments.companyId, row.companyId), eq(caseAttachments.caseId, row.id)))
      .orderBy(asc(caseAttachments.createdAt)),
  ]);
  return {
    ...row,
    labels: labelRows.map((item) => item.label),
    issueLinks: linkRows.map((item) => ({
      ...item.link,
      issue: {
        id: item.issue.id,
        identifier: item.issue.identifier,
        title: item.issue.title,
        status: item.issue.status,
      },
    })),
    documents: documentRows.map((item) => ({
      key: item.link.key,
      document: item.document,
    })),
    attachments: attachmentRows.map((item) => ({
      id: item.link.id,
      asset: item.asset,
      createdAt: item.link.createdAt,
      updatedAt: item.link.updatedAt,
    })),
  };
}

function singleFileUpload(req: Request, res: Response, maxBytes: number) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1 },
  }).single("file");
  return new Promise<void>((resolve, reject) => {
    upload(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function caseRoutes(db: Db, storage: StorageService) {
  const router = Router();

  router.post("/companies/:companyId/cases", validate(createCaseSchema), async (req, res) => {
    await assertCasesEnabled(db);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const body = req.body as z.infer<typeof createCaseSchema>;

    const result = await db.transaction(async (tx) => {
      await assertProjectBelongsToCompany(tx, { companyId, projectId: body.projectId ?? null });
      await assertParentCaseBelongsToCompany(tx, { companyId, parentCaseId: body.parentCaseId ?? null });

      const now = new Date();
      const existing = body.key
        ? await tx
          .select()
          .from(cases)
          .where(and(eq(cases.companyId, companyId), eq(cases.caseType, body.caseType), eq(cases.key, body.key)))
          .limit(1)
          .then((rows) => rows[0] ?? null)
        : null;

      if (existing) {
        const status = body.status ?? existing.status;
        const [updated] = await tx.update(cases).set({
          projectId: body.projectId ?? existing.projectId,
          title: body.title,
          summary: body.summary ?? existing.summary,
          status,
          fields: body.fields ?? existing.fields,
          parentCaseId: body.parentCaseId ?? existing.parentCaseId,
          completedAt: completedAtForStatus(status, existing.completedAt),
          updatedAt: now,
        }).where(eq(cases.id, existing.id)).returning();
        await insertCaseEvent(tx, {
          companyId,
          caseId: existing.id,
          kind: "updated",
          actor,
          payload: { upsert: true },
        });
        await autoLinkRunIssue(tx, { companyId, caseId: existing.id, actor, role: "origin" });
        return { created: false, row: updated! };
      }

      const identity = await nextCaseIdentity(tx, companyId);
      const status = body.status ?? "draft";
      const [created] = await tx.insert(cases).values({
        companyId,
        projectId: body.projectId ?? null,
        ...identity,
        caseType: body.caseType,
        key: body.key ?? null,
        title: body.title,
        summary: body.summary ?? null,
        status,
        fields: body.fields ?? {},
        parentCaseId: body.parentCaseId ?? null,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        completedAt: completedAtForStatus(status),
        createdAt: now,
        updatedAt: now,
      }).returning();
      await insertCaseEvent(tx, {
        companyId,
        caseId: created!.id,
        kind: "created",
        actor,
        payload: { caseType: body.caseType, key: body.key ?? null },
      });
      await autoLinkRunIssue(tx, { companyId, caseId: created!.id, actor, role: "origin" });
      return { created: true, row: created! };
    });

    res.status(result.created ? 201 : 200).json(await loadCaseDetail(db, result.row));
  });

  router.get("/companies/:companyId/cases", async (req, res) => {
    await assertCasesEnabled(db);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = listCasesQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest("Invalid case list query", parsed.error.issues);
    const query = parsed.data;
    const filters = [eq(cases.companyId, companyId)];
    if (query.type) filters.push(eq(cases.caseType, query.type));
    if (query.status === "active") {
      filters.push(sql`${cases.status} not in ('done', 'cancelled')`);
    } else if (query.status) {
      if (!CASE_STATUSES.includes(query.status as (typeof CASE_STATUSES)[number])) {
        throw badRequest("Invalid case status");
      }
      filters.push(eq(cases.status, query.status));
    }
    const projectId = query.projectId ?? query.project;
    if (projectId) filters.push(eq(cases.projectId, projectId));
    const labelId = query.labelId ?? query.label;
    if (labelId) {
      filters.push(sql`${cases.id} in (
        select ${caseLabels.caseId} from ${caseLabels}
        where ${caseLabels.companyId} = ${companyId} and ${caseLabels.labelId} = ${labelId}
      )`);
    }
    if (query.q) {
      const pattern = `%${query.q.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      filters.push(or(
        ilike(cases.identifier, pattern),
        ilike(cases.title, pattern),
        ilike(cases.summary, pattern),
        ilike(cases.key, pattern),
      )!);
    }

    const rows = await db
      .select()
      .from(cases)
      .where(and(...filters))
      .orderBy(desc(cases.updatedAt), desc(cases.createdAt))
      .limit(query.limit);
    res.json(rows);
  });

  router.put("/cases/:id/documents/:key", validate(upsertCaseDocumentSchema), async (req, res) => {
    await assertCasesEnabled(db);
    const caseRow = await assertCaseAccess(db, req, req.params.id as string);
    const key = parseDocumentKey(req.params.key as string);
    const actor = getActorInfo(req);
    const body = req.body as z.infer<typeof upsertCaseDocumentSchema>;

    const result = await db.transaction(async (tx) => {
      const existing = await tx
        .select({ link: caseDocuments, document: documents, revision: documentRevisions })
        .from(caseDocuments)
        .innerJoin(documents, eq(caseDocuments.documentId, documents.id))
        .leftJoin(documentRevisions, eq(documents.latestRevisionId, documentRevisions.id))
        .where(and(
          eq(caseDocuments.companyId, caseRow.companyId),
          eq(caseDocuments.caseId, caseRow.id),
          eq(caseDocuments.key, key),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (existing && !body.baseRevisionId) {
        throw conflict("Case document update requires baseRevisionId", {
          code: "stale_base_revision",
          latestRevisionId: existing.document.latestRevisionId,
          latestRevisionNumber: existing.document.latestRevisionNumber,
        });
      }
      if (existing && body.baseRevisionId !== existing.document.latestRevisionId) {
        throw conflict("Case document was updated by someone else", {
          code: "stale_base_revision",
          latestRevisionId: existing.document.latestRevisionId,
          latestRevisionNumber: existing.document.latestRevisionNumber,
          latestRevision: existing.revision,
        });
      }
      if (!existing && body.baseRevisionId) {
        throw conflict("Case document does not exist yet", {
          code: "stale_base_revision",
          latestRevisionId: null,
          latestRevisionNumber: null,
        });
      }

      const now = new Date();
      const [document] = existing
        ? await tx.update(documents).set({
          title: body.title ?? existing.document.title,
          format: body.format,
          updatedAt: now,
          updatedByAgentId: actor.agentId,
          updatedByUserId: actor.actorType === "user" ? actor.actorId : null,
        }).where(eq(documents.id, existing.document.id)).returning()
        : await tx.insert(documents).values({
          companyId: caseRow.companyId,
          title: body.title ?? key,
          format: body.format,
          latestBody: body.body,
          latestRevisionNumber: 1,
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          updatedByAgentId: actor.agentId,
          updatedByUserId: actor.actorType === "user" ? actor.actorId : null,
          createdAt: now,
          updatedAt: now,
        }).returning();
      const nextRevisionNumber = existing ? existing.document.latestRevisionNumber + 1 : 1;
      const [revision] = await tx.insert(documentRevisions).values({
        companyId: caseRow.companyId,
        documentId: document!.id,
        revisionNumber: nextRevisionNumber,
        title: body.title ?? document!.title,
        format: body.format,
        body: body.body,
        changeSummary: body.changeSummary ?? null,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        createdByRunId: actor.runId && isUuidLike(actor.runId) ? actor.runId : null,
        createdAt: now,
      }).returning();
      await tx.update(documents).set({
        title: body.title ?? document!.title,
        format: body.format,
        latestBody: body.body,
        latestRevisionId: revision!.id,
        latestRevisionNumber: revision!.revisionNumber,
        updatedByAgentId: actor.agentId,
        updatedByUserId: actor.actorType === "user" ? actor.actorId : null,
        updatedAt: now,
      }).where(eq(documents.id, document!.id));
      if (!existing) {
        await tx.insert(caseDocuments).values({
          companyId: caseRow.companyId,
          caseId: caseRow.id,
          documentId: document!.id,
          key,
          createdAt: now,
          updatedAt: now,
        });
      } else {
        await tx.update(caseDocuments).set({ updatedAt: now }).where(eq(caseDocuments.documentId, document!.id));
      }
      await insertCaseEvent(tx, {
        companyId: caseRow.companyId,
        caseId: caseRow.id,
        kind: "document_revised",
        actor,
        payload: { key, documentId: document!.id, revisionId: revision!.id, revisionNumber: revision!.revisionNumber },
      });
      await autoLinkRunIssue(tx, { companyId: caseRow.companyId, caseId: caseRow.id, actor, role: "work" });
      return {
        document: {
          ...document!,
          title: body.title ?? document!.title,
          format: body.format,
          latestBody: body.body,
          latestRevisionId: revision!.id,
          latestRevisionNumber: revision!.revisionNumber,
          updatedAt: now,
        },
        revision,
      };
    });
    res.json(result);
  });

  router.post("/cases/:id/links", validate(createIssueLinkSchema), async (req, res) => {
    await assertCasesEnabled(db);
    const caseRow = await assertCaseAccess(db, req, req.params.id as string);
    const actor = getActorInfo(req);
    const body = req.body as z.infer<typeof createIssueLinkSchema>;

    const result = await db.transaction(async (tx) => {
      const issue = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, body.issueId), eq(issues.companyId, caseRow.companyId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!issue) throw unprocessable("Issue does not belong to case company");
      const now = new Date();
      const [link] = await tx.insert(caseIssueLinks).values({
        companyId: caseRow.companyId,
        caseId: caseRow.id,
        issueId: body.issueId,
        role: body.role,
        createdByRunId: actor.runId && isUuidLike(actor.runId) ? actor.runId : null,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing({
        target: [caseIssueLinks.caseId, caseIssueLinks.issueId],
      }).returning();
      if (link) {
        await insertCaseEvent(tx, {
          companyId: caseRow.companyId,
          caseId: caseRow.id,
          kind: "issue_linked",
          actor,
          payload: { issueId: body.issueId, role: body.role, autoLinked: false },
        });
      }
      return link ?? await tx
        .select()
        .from(caseIssueLinks)
        .where(and(eq(caseIssueLinks.caseId, caseRow.id), eq(caseIssueLinks.issueId, body.issueId)))
        .limit(1)
        .then((rows) => rows[0]);
    });
    res.status(201).json(result);
  });

  router.post("/cases/:id/attachments", async (req, res) => {
    await assertCasesEnabled(db);
    const caseRow = await assertCaseAccess(db, req, req.params.id as string);
    const actor = getActorInfo(req);
    const [company] = await db
      .select({ attachmentMaxBytes: companies.attachmentMaxBytes })
      .from(companies)
      .where(eq(companies.id, caseRow.companyId))
      .limit(1);
    const maxBytes = company?.attachmentMaxBytes ?? 10 * 1024 * 1024;

    try {
      await singleFileUpload(req, res, maxBytes);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          throw unprocessable(`Attachment exceeds ${maxBytes} bytes`);
        }
        throw badRequest(err.message);
      }
      throw err;
    }
    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) throw badRequest("Missing file field 'file'");
    if (file.buffer.length <= 0) throw unprocessable("Attachment is empty");

    const stored = await storage.putFile({
      companyId: caseRow.companyId,
      namespace: `cases/${caseRow.id}`,
      originalFilename: file.originalname || null,
      contentType: normalizeContentType(file.mimetype),
      body: file.buffer,
    });
    const result = await db.transaction(async (tx) => {
      const now = new Date();
      const [asset] = await tx.insert(assets).values({
        companyId: caseRow.companyId,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        createdAt: now,
        updatedAt: now,
      }).returning();
      const [attachment] = await tx.insert(caseAttachments).values({
        companyId: caseRow.companyId,
        caseId: caseRow.id,
        assetId: asset!.id,
        createdAt: now,
        updatedAt: now,
      }).returning();
      await insertCaseEvent(tx, {
        companyId: caseRow.companyId,
        caseId: caseRow.id,
        kind: "attachment_added",
        actor,
        payload: { attachmentId: attachment!.id, assetId: asset!.id, originalFilename: asset!.originalFilename },
      });
      await autoLinkRunIssue(tx, { companyId: caseRow.companyId, caseId: caseRow.id, actor, role: "work" });
      return { ...attachment!, asset };
    });
    res.status(201).json(result);
  });

  router.get("/cases/:id/events", async (req, res) => {
    await assertCasesEnabled(db);
    const caseRow = await assertCaseAccess(db, req, req.params.id as string);
    const parsed = listEventsQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest("Invalid case events query", parsed.error.issues);
    const rows = await db
      .select()
      .from(caseEvents)
      .where(and(eq(caseEvents.companyId, caseRow.companyId), eq(caseEvents.caseId, caseRow.id)))
      .orderBy(desc(caseEvents.createdAt), desc(caseEvents.id))
      .limit(parsed.data.limit);
    res.json(rows);
  });

  router.get("/cases/:id", async (req, res) => {
    await assertCasesEnabled(db);
    const row = await assertCaseAccess(db, req, req.params.id as string);
    res.json(await loadCaseDetail(db, row));
  });

  router.patch("/cases/:id", validate(patchCaseSchema), async (req, res) => {
    await assertCasesEnabled(db);
    const caseRow = await assertCaseAccess(db, req, req.params.id as string);
    const actor = getActorInfo(req);
    const body = req.body as z.infer<typeof patchCaseSchema>;
    const nextLabelIds = body.labelIds ?? body.labels;

    const updated = await db.transaction(async (tx) => {
      await assertProjectBelongsToCompany(tx, { companyId: caseRow.companyId, projectId: body.projectId ?? null });
      await assertParentCaseBelongsToCompany(tx, {
        companyId: caseRow.companyId,
        caseId: caseRow.id,
        parentCaseId: body.parentCaseId ?? null,
      });
      if (nextLabelIds) await assertLabelsBelongToCompany(tx, caseRow.companyId, nextLabelIds);

      const now = new Date();
      const status = body.status ?? caseRow.status;
      const [row] = await tx.update(cases).set({
        ...(Object.hasOwn(body, "projectId") ? { projectId: body.projectId ?? null } : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(Object.hasOwn(body, "summary") ? { summary: body.summary ?? null } : {}),
        ...(body.status !== undefined ? { status } : {}),
        ...(body.fields !== undefined ? { fields: body.fields } : {}),
        ...(Object.hasOwn(body, "parentCaseId") ? { parentCaseId: body.parentCaseId ?? null } : {}),
        completedAt: body.status !== undefined ? completedAtForStatus(status, caseRow.completedAt) : caseRow.completedAt,
        updatedAt: now,
      }).where(eq(cases.id, caseRow.id)).returning();

      if (nextLabelIds) {
        const current = await tx
          .select({ labelId: caseLabels.labelId })
          .from(caseLabels)
          .where(and(eq(caseLabels.companyId, caseRow.companyId), eq(caseLabels.caseId, caseRow.id)));
        const currentIds = new Set(current.map((item) => item.labelId));
        const desiredIds = new Set(nextLabelIds);
        const added = [...desiredIds].filter((id) => !currentIds.has(id));
        const removed = [...currentIds].filter((id) => !desiredIds.has(id));
        if (removed.length > 0) {
          await tx.delete(caseLabels).where(and(eq(caseLabels.caseId, caseRow.id), inArray(caseLabels.labelId, removed)));
          for (const labelId of removed) {
            await insertCaseEvent(tx, {
              companyId: caseRow.companyId,
              caseId: caseRow.id,
              kind: "label_removed",
              actor,
              payload: { labelId },
            });
          }
        }
        if (added.length > 0) {
          await tx.insert(caseLabels).values(added.map((labelId) => ({
            companyId: caseRow.companyId,
            caseId: caseRow.id,
            labelId,
            createdAt: now,
            updatedAt: now,
          }))).onConflictDoNothing();
          for (const labelId of added) {
            await insertCaseEvent(tx, {
              companyId: caseRow.companyId,
              caseId: caseRow.id,
              kind: "label_added",
              actor,
              payload: { labelId },
            });
          }
        }
      }

      const kind = body.status !== undefined
        ? "status_changed"
        : body.fields !== undefined
          ? "fields_changed"
          : Object.hasOwn(body, "parentCaseId") && body.parentCaseId
            ? "child_linked"
            : "updated";
      await insertCaseEvent(tx, {
        companyId: caseRow.companyId,
        caseId: caseRow.id,
        kind,
        actor,
        payload: {
          previousStatus: body.status !== undefined ? caseRow.status : undefined,
          status: body.status,
          parentCaseId: body.parentCaseId,
        },
      });
      await autoLinkRunIssue(tx, { companyId: caseRow.companyId, caseId: caseRow.id, actor, role: "work" });
      return row!;
    });
    res.json(await loadCaseDetail(db, updated));
  });

  return router;
}
