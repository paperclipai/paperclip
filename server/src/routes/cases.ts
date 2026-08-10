import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
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
import {
  createDocumentAnnotationCommentSchema,
  createDocumentAnnotationThreadSchema,
  updateDocumentAnnotationThreadSchema,
  isUuidLike,
} from "@paperclipai/shared";
import { normalizeContentType } from "../attachment-types.js";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { documentAnnotationService, logActivity } from "../services/index.js";
import type { StorageService } from "../storage/types.js";
import { assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";

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

const queryListParamSchema = z.union([z.string(), z.array(z.string())]).optional();

const listCasesQuerySchema = z.object({
  type: z.string().trim().min(1).max(120).optional(),
  types: queryListParamSchema,
  status: z.string().trim().min(1).max(120).optional(),
  statuses: queryListParamSchema,
  project: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  projectIds: queryListParamSchema,
  includeNoProject: z.enum(["true", "false", "1", "0"]).optional(),
  label: z.string().uuid().optional(),
  labelId: z.string().uuid().optional(),
  parent: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(200).optional(),
  includeAncestors: z.enum(["true", "false", "1", "0"]).optional(),
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

async function lockCaseUpsertKey(db: CaseRouteDb, input: { companyId: string; caseType: string; key: string | null | undefined }) {
  const lockKey = `paperclip:case-upsert:${input.companyId}:${input.caseType}:${input.key ?? "<null>"}`;
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
}

async function lockCaseDocumentKey(db: CaseRouteDb, input: { companyId: string; caseId: string; key: string }) {
  const lockKey = `paperclip:case-document:${input.companyId}:${input.caseId}:${input.key}`;
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
}

async function lockCaseLabels(db: CaseRouteDb, input: { companyId: string; caseId: string }) {
  const lockKey = `paperclip:case-labels:${input.companyId}:${input.caseId}`;
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
}

function parseDocumentKey(raw: string | undefined) {
  const parsed = documentKeySchema.safeParse(raw);
  if (!parsed.success) throw badRequest("Invalid document key", parsed.error.issues);
  return parsed.data;
}

function parseBooleanQuery(value: unknown) {
  return value === true || value === "true" || value === "1";
}

function parseQueryList(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);
}

function annotationActorInput(req: Request) {
  const actor = getActorInfo(req);
  return {
    actor,
    annotationActor: {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
      runId: actor.runId,
    },
  };
}

async function loadCaseByIdOrIdentifier(db: CaseRouteDb, idOrIdentifier: string, companyIds?: string[]) {
  if (companyIds && companyIds.length === 0) return null;
  const normalizedIdentifier = idOrIdentifier.trim().toUpperCase();
  const identityWhere = isUuidLike(idOrIdentifier)
    ? or(eq(cases.id, idOrIdentifier), eq(cases.identifier, normalizedIdentifier))
    : eq(cases.identifier, normalizedIdentifier);
  const where = companyIds
    ? and(identityWhere, inArray(cases.companyId, companyIds))
    : identityWhere;
  return db.select().from(cases).where(where).limit(1).then((rows) => rows[0] ?? null);
}

async function loadIssueByIdOrIdentifier(db: CaseRouteDb, idOrIdentifier: string, companyIds?: string[]) {
  if (companyIds && companyIds.length === 0) return null;
  const normalizedIdentifier = idOrIdentifier.trim().toUpperCase();
  const identityWhere = isUuidLike(idOrIdentifier)
    ? or(eq(issues.id, idOrIdentifier), eq(issues.identifier, normalizedIdentifier))
    : eq(issues.identifier, normalizedIdentifier);
  const where = companyIds
    ? and(identityWhere, inArray(issues.companyId, companyIds))
    : identityWhere;
  return db
    .select({ id: issues.id, companyId: issues.companyId })
    .from(issues)
    .where(where)
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

function caseLookupCompanyIds(req: Request) {
  if (req.actor.type === "agent") return req.actor.companyId ? [req.actor.companyId] : [];
  if (req.actor.type === "board" && req.actor.source === "local_implicit") return undefined;
  if (req.actor.type === "board" && Array.isArray(req.actor.companyIds) && req.actor.companyIds.length > 0) {
    return req.actor.companyIds;
  }
  if (req.actor.type === "board" && req.actor.isInstanceAdmin) return undefined;
  return [];
}

async function assertCaseAccess(db: Db, req: Request, idOrIdentifier: string) {
  const row = await loadCaseByIdOrIdentifier(db, idOrIdentifier, caseLookupCompanyIds(req));
  if (!row || !hasCompanyAccess(req, row.companyId)) throw notFound("Case not found");
  assertCompanyAccess(req, row.companyId);
  return row;
}

// The pipelines feature registers its own /cases/:caseId routes after this
// router. On paths both features share, return null (caller falls through via
// next()) when the id is not a new-Cases row so pipeline case requests still
// reach their handler regardless of the enableCases flag.
async function resolveSharedPathCase(db: Db, req: Request, idOrIdentifier: string) {
  const companyIds = caseLookupCompanyIds(req);
  const row = await loadCaseByIdOrIdentifier(db, idOrIdentifier, companyIds);
  if (!row || !hasCompanyAccess(req, row.companyId)) return null;
  await assertCasesEnabled(db);
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

/** Batch resolve agent display names for a set of agent ids. */
async function resolveAgentNames(db: CaseRouteDb, agentIds: (string | null)[]) {
  const valid = [...new Set(agentIds.filter((id): id is string => !!id))];
  if (valid.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(inArray(agents.id, valid));
  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * Batch resolve run → issue attribution. Mirrors resolveIssueForRun's precedence
 * (latest-updated issue whose execution/checkout/origin run matches), but for a
 * whole set of runs at once so the activity feed / revisions rail avoid N+1s.
 */
async function resolveIssuesForRuns(db: CaseRouteDb, companyId: string, runIds: (string | null)[]) {
  const valid = [...new Set(runIds.filter((id): id is string => !!id && isUuidLike(id)))];
  const map = new Map<string, { id: string; identifier: string; title: string; status: string }>();
  if (valid.length === 0) return map;
  const rows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      executionRunId: issues.executionRunId,
      checkoutRunId: issues.checkoutRunId,
      originRunId: issues.originRunId,
      updatedAt: issues.updatedAt,
      createdAt: issues.createdAt,
    })
    .from(issues)
    .where(and(
      eq(issues.companyId, companyId),
      or(
        inArray(issues.executionRunId, valid),
        inArray(issues.checkoutRunId, valid),
        inArray(issues.originRunId, valid),
      ),
    ))
    .orderBy(desc(issues.updatedAt), desc(issues.createdAt));
  for (const runId of valid) {
    const match = rows.find(
      (row) => row.executionRunId === runId || row.checkoutRunId === runId || row.originRunId === runId,
    );
    if (match) {
      map.set(runId, { id: match.id, identifier: match.identifier ?? match.id, title: match.title, status: match.status });
    }
  }
  return map;
}

function payloadIssueIdForEvent(kind: string, payload: Record<string, unknown> | null | undefined) {
  if (kind !== "issue_linked" && kind !== "issue_unlinked") return null;
  const issueId = payload?.issueId;
  return typeof issueId === "string" && isUuidLike(issueId) ? issueId : null;
}

async function resolveIssuesByIds(db: CaseRouteDb, companyId: string, issueIds: (string | null)[]) {
  const valid = [...new Set(issueIds.filter((id): id is string => !!id && isUuidLike(id)))];
  const map = new Map<string, { id: string; identifier: string; title: string; status: string }>();
  if (valid.length === 0) return map;
  const rows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, valid)));
  for (const row of rows) {
    map.set(row.id, { id: row.id, identifier: row.identifier ?? row.id, title: row.title, status: row.status });
  }
  return map;
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

type PatchCaseBody = z.infer<typeof patchCaseSchema>;

export function buildCasePatchUpdateValues(
  body: PatchCaseBody,
  caseRow: Pick<typeof cases.$inferSelect, "status" | "completedAt">,
  now: Date,
) {
  const status = body.status ?? caseRow.status;
  return {
    ...(Object.hasOwn(body, "projectId") ? { projectId: body.projectId ?? null } : {}),
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(Object.hasOwn(body, "summary") ? { summary: body.summary ?? null } : {}),
    ...(body.status !== undefined ? { status, completedAt: completedAtForStatus(status, caseRow.completedAt) } : {}),
    ...(body.fields !== undefined ? { fields: body.fields } : {}),
    ...(Object.hasOwn(body, "parentCaseId") ? { parentCaseId: body.parentCaseId ?? null } : {}),
    updatedAt: now,
  };
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
  const parent = row.parentCaseId
    ? await db
      .select({
        id: cases.id,
        identifier: cases.identifier,
        title: cases.title,
        caseType: cases.caseType,
        status: cases.status,
      })
      .from(cases)
      .where(eq(cases.id, row.parentCaseId))
      .limit(1)
      .then((rows) => rows[0] ?? null)
    : null;
  return {
    ...row,
    parent,
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

async function loadCaseDocumentLink(db: CaseRouteDb, input: { companyId: string; caseId: string; key: string }) {
  return db
    .select({ link: caseDocuments, document: documents })
    .from(caseDocuments)
    .innerJoin(documents, eq(caseDocuments.documentId, documents.id))
    .where(and(
      eq(caseDocuments.companyId, input.companyId),
      eq(caseDocuments.caseId, input.caseId),
      eq(caseDocuments.key, input.key),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function includeCaseAncestors(
  db: CaseRouteDb,
  companyId: string,
  baseRows: Array<typeof cases.$inferSelect>,
) {
  const baseIds = new Set(baseRows.map((row) => row.id));
  const rowsById = new Map(baseRows.map((row) => [row.id, row]));
  const ancestorRows: Array<typeof cases.$inferSelect> = [];
  let pending = [...new Set(
    baseRows
      .map((row) => row.parentCaseId)
      .filter((id): id is string => {
        if (!id) return false;
        return !rowsById.has(id);
      }),
  )];

  while (pending.length > 0) {
    const ancestors = await db
      .select()
      .from(cases)
      .where(and(eq(cases.companyId, companyId), inArray(cases.id, pending)));
    const nextPending = new Set<string>();
    for (const row of ancestors) {
      if (rowsById.has(row.id)) continue;
      rowsById.set(row.id, row);
      ancestorRows.push(row);
      if (row.parentCaseId && !rowsById.has(row.parentCaseId)) {
        nextPending.add(row.parentCaseId);
      }
    }
    pending = [...nextPending];
  }

  return [...baseRows, ...ancestorRows].map((row) => ({
    ...row,
    matchesListFilters: baseIds.has(row.id),
  }));
}

function caseDocumentResponse(input: { key: string; document: typeof documents.$inferSelect }) {
  return {
    ...input.document,
    key: input.key,
    body: input.document.latestBody,
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
  const documentAnnotationsSvc = documentAnnotationService(db);

  async function logCaseAnnotationRemaps(input: {
    caseRow: typeof cases.$inferSelect;
    key: string;
    document: Pick<typeof documents.$inferSelect, "id" | "latestRevisionId" | "latestRevisionNumber">;
    body: string;
    actor: CaseActor;
  }) {
    const remapped = await documentAnnotationsSvc.remapOpenThreadsForCaseDocument({
      caseId: input.caseRow.id,
      key: input.key,
      documentId: input.document.id,
      nextRevisionId: input.document.latestRevisionId,
      nextRevisionNumber: input.document.latestRevisionNumber,
      nextBody: input.body,
    });
    for (const remap of remapped) {
      await logActivity(db, {
        companyId: input.caseRow.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        action: "case.document_annotation_remapped",
        entityType: "case",
        entityId: input.caseRow.id,
        details: {
          key: input.key,
          documentKey: input.key,
          documentId: input.document.id,
          threadId: remap.thread.id,
          revisionNumber: input.document.latestRevisionNumber,
          anchorState: remap.thread.anchorState,
          anchorConfidence: remap.thread.anchorConfidence,
          snapshotId: remap.snapshot.id,
        },
      });
    }
  }

  router.post("/companies/:companyId/cases", validate(createCaseSchema), async (req, res) => {
    await assertCasesEnabled(db);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const body = req.body as z.infer<typeof createCaseSchema>;

    const result = await db.transaction(async (tx) => {
      await assertProjectBelongsToCompany(tx, { companyId, projectId: body.projectId ?? null });
      await assertParentCaseBelongsToCompany(tx, { companyId, parentCaseId: body.parentCaseId ?? null });
      await lockCaseUpsertKey(tx, { companyId, caseType: body.caseType, key: body.key });
      const keyFilter = body.key ? eq(cases.key, body.key) : isNull(cases.key);

      const now = new Date();
      const existing = await tx
        .select()
        .from(cases)
        .where(and(eq(cases.companyId, companyId), eq(cases.caseType, body.caseType), keyFilter))
        .limit(1)
        .then((rows) => rows[0] ?? null);

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
    const typeFilters = parseQueryList(query.types ?? query.type);
    if (typeFilters.length === 1) filters.push(eq(cases.caseType, typeFilters[0]!));
    else if (typeFilters.length > 1) filters.push(inArray(cases.caseType, typeFilters));

    const statusFilters = parseQueryList(query.statuses ?? (query.status === "active" ? undefined : query.status));
    if (query.status === "active" && statusFilters.length === 0) {
      filters.push(sql`${cases.status} not in ('done', 'cancelled')`);
    } else if (statusFilters.length > 0) {
      for (const status of statusFilters) {
        if (!CASE_STATUSES.includes(status as (typeof CASE_STATUSES)[number])) {
          throw badRequest("Invalid case status");
        }
      }
      filters.push(statusFilters.length === 1 ? eq(cases.status, statusFilters[0]!) : inArray(cases.status, statusFilters));
    }

    const projectFilters = parseQueryList(query.projectIds ?? query.projectId ?? query.project);
    for (const projectId of projectFilters) {
      if (!isUuidLike(projectId)) throw badRequest("Invalid project id");
    }
    const includeNoProject = parseBooleanQuery(query.includeNoProject);
    if (projectFilters.length > 0 && includeNoProject) {
      filters.push(or(inArray(cases.projectId, projectFilters), isNull(cases.projectId))!);
    } else if (projectFilters.length === 1) {
      filters.push(eq(cases.projectId, projectFilters[0]!));
    } else if (projectFilters.length > 1) {
      filters.push(inArray(cases.projectId, projectFilters));
    } else if (includeNoProject) {
      filters.push(isNull(cases.projectId));
    }
    if (query.parent) filters.push(eq(cases.parentCaseId, query.parent));
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
    res.json(parseBooleanQuery(query.includeAncestors) ? await includeCaseAncestors(db, companyId, rows) : rows);
  });

  router.get("/cases/:id/documents/:key", async (req, res, next) => {
    const caseRow = await resolveSharedPathCase(db, req, req.params.id as string);
    if (!caseRow) return next();
    const key = parseDocumentKey(req.params.key as string);
    const link = await loadCaseDocumentLink(db, { companyId: caseRow.companyId, caseId: caseRow.id, key });
    if (!link) throw notFound("Case document not found");
    res.json(caseDocumentResponse({ key, document: link.document }));
  });

  router.get("/cases/:id/documents/:key/annotations", async (req, res, next) => {
    const caseRow = await resolveSharedPathCase(db, req, req.params.id as string);
    if (!caseRow) return next();
    const key = parseDocumentKey(req.params.key as string);
    const status = req.query.status === "resolved" || req.query.status === "all" ? req.query.status : "open";
    const threads = await documentAnnotationsSvc.listThreadsForCaseDocument(caseRow.id, key, {
      status,
      includeComments: parseBooleanQuery(req.query.includeComments),
    });
    res.json(threads);
  });

  router.get("/cases/:id/documents/:key/annotations/:threadId", async (req, res, next) => {
    const caseRow = await resolveSharedPathCase(db, req, req.params.id as string);
    if (!caseRow) return next();
    const key = parseDocumentKey(req.params.key as string);
    const thread = await documentAnnotationsSvc.getThreadForCaseDocument(
      caseRow.id,
      key,
      req.params.threadId as string,
    );
    if (!thread) throw notFound("Annotation thread not found");
    res.json(thread);
  });

  router.post(
    "/cases/:id/documents/:key/annotations",
    validate(createDocumentAnnotationThreadSchema),
    async (req, res, next) => {
      const caseRow = await resolveSharedPathCase(db, req, req.params.id as string);
      if (!caseRow) return next();
      const key = parseDocumentKey(req.params.key as string);
      const { actor, annotationActor } = annotationActorInput(req);
      const thread = await documentAnnotationsSvc.createCaseThread(
        caseRow.id,
        key,
        req.body,
        annotationActor,
      );
      const firstComment = thread.comments[0];
      await logActivity(db, {
        companyId: caseRow.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "case.document_annotation_thread_created",
        entityType: "case",
        entityId: caseRow.id,
        details: {
          key: thread.documentKey,
          documentKey: thread.documentKey,
          documentId: thread.documentId,
          threadId: thread.id,
          commentId: firstComment?.id ?? null,
          revisionNumber: thread.currentRevisionNumber,
          quote: thread.selectedText.slice(0, 240),
        },
      });
      res.status(201).json(thread);
    },
  );

  router.post(
    "/cases/:id/documents/:key/annotations/:threadId/comments",
    validate(createDocumentAnnotationCommentSchema),
    async (req, res, next) => {
      const caseRow = await resolveSharedPathCase(db, req, req.params.id as string);
      if (!caseRow) return next();
      const key = parseDocumentKey(req.params.key as string);
      const { actor, annotationActor } = annotationActorInput(req);
      const comment = await documentAnnotationsSvc.addCaseComment(
        caseRow.id,
        key,
        req.params.threadId as string,
        req.body,
        annotationActor,
      );
      await logActivity(db, {
        companyId: caseRow.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "case.document_annotation_comment_added",
        entityType: "case",
        entityId: caseRow.id,
        details: {
          key,
          documentKey: key,
          threadId: comment.threadId,
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
        },
      });
      res.status(201).json(comment);
    },
  );

  router.patch(
    "/cases/:id/documents/:key/annotations/:threadId",
    validate(updateDocumentAnnotationThreadSchema),
    async (req, res, next) => {
      const caseRow = await resolveSharedPathCase(db, req, req.params.id as string);
      if (!caseRow) return next();
      const key = parseDocumentKey(req.params.key as string);
      const { actor, annotationActor } = annotationActorInput(req);
      const thread = await documentAnnotationsSvc.updateCaseThread(
        caseRow.id,
        key,
        req.params.threadId as string,
        req.body,
        annotationActor,
      );
      await logActivity(db, {
        companyId: caseRow.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: thread.status === "resolved"
          ? "case.document_annotation_thread_resolved"
          : "case.document_annotation_thread_reopened",
        entityType: "case",
        entityId: caseRow.id,
        details: {
          key: thread.documentKey,
          documentKey: thread.documentKey,
          documentId: thread.documentId,
          threadId: thread.id,
          status: thread.status,
        },
      });
      res.json(thread);
    },
  );

  router.put("/cases/:id/documents/:key", async (req, res, next) => {
    const caseRow = await resolveSharedPathCase(db, req, req.params.id as string);
    if (!caseRow) return next();
    const key = parseDocumentKey(req.params.key as string);
    const actor = getActorInfo(req);
    const body = upsertCaseDocumentSchema.parse(req.body);

    const result = await db.transaction(async (tx) => {
      await lockCaseDocumentKey(tx, { companyId: caseRow.companyId, caseId: caseRow.id, key });
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

      if (existing?.document.lockedAt) {
        throw conflict("Document is locked", {
          key,
          documentId: existing.document.id,
          lockedAt: existing.document.lockedAt,
        });
      }
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
    await logCaseAnnotationRemaps({
      caseRow,
      key,
      document: result.document,
      body: result.document.latestBody,
      actor,
    });
    res.json(result);
  });

  router.post("/cases/:id/documents/:key/lock", async (req, res, next) => {
    const caseRow = await resolveSharedPathCase(db, req, req.params.id as string);
    if (!caseRow) return next();
    const key = parseDocumentKey(req.params.key as string);
    const actor = getActorInfo(req);
    const result = await db.transaction(async (tx) => {
      await lockCaseDocumentKey(tx, { companyId: caseRow.companyId, caseId: caseRow.id, key });
      const link = await loadCaseDocumentLink(tx, { companyId: caseRow.companyId, caseId: caseRow.id, key });
      if (!link) throw notFound("Case document not found");
      if (link.document.lockedAt) return caseDocumentResponse({ key, document: link.document });
      const now = new Date();
      const [document] = await tx.update(documents).set({
        lockedAt: now,
        lockedByAgentId: actor.agentId,
        lockedByUserId: actor.actorType === "user" ? actor.actorId : null,
        updatedAt: now,
      }).where(eq(documents.id, link.document.id)).returning();
      await tx.update(caseDocuments).set({ updatedAt: now }).where(eq(caseDocuments.documentId, link.document.id));
      return caseDocumentResponse({ key, document: document! });
    });
    res.json(result);
  });

  router.post("/cases/:id/documents/:key/unlock", async (req, res, next) => {
    const caseRow = await resolveSharedPathCase(db, req, req.params.id as string);
    if (!caseRow) return next();
    const key = parseDocumentKey(req.params.key as string);
    const result = await db.transaction(async (tx) => {
      await lockCaseDocumentKey(tx, { companyId: caseRow.companyId, caseId: caseRow.id, key });
      const link = await loadCaseDocumentLink(tx, { companyId: caseRow.companyId, caseId: caseRow.id, key });
      if (!link) throw notFound("Case document not found");
      if (!link.document.lockedAt) return caseDocumentResponse({ key, document: link.document });
      const now = new Date();
      const [document] = await tx.update(documents).set({
        lockedAt: null,
        lockedByAgentId: null,
        lockedByUserId: null,
        updatedAt: now,
      }).where(eq(documents.id, link.document.id)).returning();
      await tx.update(caseDocuments).set({ updatedAt: now }).where(eq(caseDocuments.documentId, link.document.id));
      return caseDocumentResponse({ key, document: document! });
    });
    res.json(result);
  });

  router.post("/cases/:id/documents/:key/revisions/:revisionId/restore", async (req, res, next) => {
    const caseRow = await resolveSharedPathCase(db, req, req.params.id as string);
    if (!caseRow) return next();
    const key = parseDocumentKey(req.params.key as string);
    const revisionId = req.params.revisionId as string;
    const actor = getActorInfo(req);

    const result = await db.transaction(async (tx) => {
      await lockCaseDocumentKey(tx, { companyId: caseRow.companyId, caseId: caseRow.id, key });
      const existing = await loadCaseDocumentLink(tx, { companyId: caseRow.companyId, caseId: caseRow.id, key });
      if (!existing) throw notFound("Case document not found");
      if (existing.document.lockedAt) {
        throw conflict("Document is locked", {
          key,
          documentId: existing.document.id,
          lockedAt: existing.document.lockedAt,
        });
      }
      const sourceRevision = await tx
        .select()
        .from(documentRevisions)
        .where(and(eq(documentRevisions.id, revisionId), eq(documentRevisions.documentId, existing.document.id)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!sourceRevision) throw notFound("Case document revision not found");
      if (existing.document.latestRevisionId === sourceRevision.id) {
        throw conflict("Selected revision is already the latest revision", {
          currentRevisionId: existing.document.latestRevisionId,
        });
      }

      const now = new Date();
      const nextRevisionNumber = existing.document.latestRevisionNumber + 1;
      const [restoredRevision] = await tx.insert(documentRevisions).values({
        companyId: caseRow.companyId,
        documentId: existing.document.id,
        revisionNumber: nextRevisionNumber,
        title: sourceRevision.title ?? null,
        format: sourceRevision.format,
        body: sourceRevision.body,
        changeSummary: `Restored from revision ${sourceRevision.revisionNumber}`,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        createdByRunId: actor.runId && isUuidLike(actor.runId) ? actor.runId : null,
        createdAt: now,
      }).returning();
      const [document] = await tx.update(documents).set({
        title: sourceRevision.title ?? null,
        format: sourceRevision.format,
        latestBody: sourceRevision.body,
        latestRevisionId: restoredRevision!.id,
        latestRevisionNumber: nextRevisionNumber,
        updatedByAgentId: actor.agentId,
        updatedByUserId: actor.actorType === "user" ? actor.actorId : null,
        updatedAt: now,
      }).where(eq(documents.id, existing.document.id)).returning();
      await tx.update(caseDocuments).set({ updatedAt: now }).where(eq(caseDocuments.documentId, existing.document.id));
      await insertCaseEvent(tx, {
        companyId: caseRow.companyId,
        caseId: caseRow.id,
        kind: "document_revised",
        actor,
        payload: {
          key,
          documentId: existing.document.id,
          revisionId: restoredRevision!.id,
          revisionNumber: restoredRevision!.revisionNumber,
          restoredFromRevisionId: sourceRevision.id,
          restoredFromRevisionNumber: sourceRevision.revisionNumber,
        },
      });
      await autoLinkRunIssue(tx, { companyId: caseRow.companyId, caseId: caseRow.id, actor, role: "work" });
      return {
        document: caseDocumentResponse({ key, document: document! }),
        revision: restoredRevision!,
        restoredFromRevisionId: sourceRevision.id,
        restoredFromRevisionNumber: sourceRevision.revisionNumber,
      };
    });
    await logCaseAnnotationRemaps({
      caseRow,
      key,
      document: result.document,
      body: result.document.body,
      actor,
    });
    res.json(result);
  });

  router.delete("/cases/:id/documents/:key", async (req, res, next) => {
    const caseRow = await resolveSharedPathCase(db, req, req.params.id as string);
    if (!caseRow) return next();
    const key = parseDocumentKey(req.params.key as string);
    await db.transaction(async (tx) => {
      await lockCaseDocumentKey(tx, { companyId: caseRow.companyId, caseId: caseRow.id, key });
      const link = await loadCaseDocumentLink(tx, { companyId: caseRow.companyId, caseId: caseRow.id, key });
      if (!link) return;
      if (link.document.lockedAt) {
        throw conflict("Document is locked", {
          key,
          documentId: link.document.id,
          lockedAt: link.document.lockedAt,
        });
      }
      await tx.delete(caseDocuments).where(eq(caseDocuments.documentId, link.document.id));
      await tx.delete(documents).where(eq(documents.id, link.document.id));
    });
    res.json({ ok: true });
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

  router.get("/cases/:id/events", async (req, res, next) => {
    const caseRow = await resolveSharedPathCase(db, req, req.params.id as string);
    if (!caseRow) return next();
    const parsed = listEventsQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest("Invalid case events query", parsed.error.issues);
    const rows = await db
      .select()
      .from(caseEvents)
      .where(and(eq(caseEvents.companyId, caseRow.companyId), eq(caseEvents.caseId, caseRow.id)))
      .orderBy(desc(caseEvents.createdAt), desc(caseEvents.id))
      .limit(parsed.data.limit);
    // Enrich each row with its actor's display name, run→issue attribution,
    // and the linked issue captured in link/unlink payloads.
    const payloadIssueIds = rows.map((row) => payloadIssueIdForEvent(row.kind, row.payload));
    const [agentNames, issueMap, payloadIssueMap] = await Promise.all([
      resolveAgentNames(db, rows.map((row) => row.actorAgentId)),
      resolveIssuesForRuns(db, caseRow.companyId, rows.map((row) => row.runId)),
      resolveIssuesByIds(db, caseRow.companyId, payloadIssueIds),
    ]);
    res.json(rows.map((row) => ({
      ...row,
      actorAgentName: row.actorAgentId ? agentNames.get(row.actorAgentId) ?? null : null,
      issue: payloadIssueMap.get(payloadIssueIdForEvent(row.kind, row.payload) ?? "")
        ?? (row.runId ? issueMap.get(row.runId) ?? null : null),
    })));
  });

  router.get("/cases/:id/documents/:key/revisions", async (req, res, next) => {
    const caseRow = await resolveSharedPathCase(db, req, req.params.id as string);
    if (!caseRow) return next();
    const key = parseDocumentKey(req.params.key as string);
    const link = await db
      .select({ documentId: caseDocuments.documentId, document: documents })
      .from(caseDocuments)
      .innerJoin(documents, eq(caseDocuments.documentId, documents.id))
      .where(and(
        eq(caseDocuments.companyId, caseRow.companyId),
        eq(caseDocuments.caseId, caseRow.id),
        eq(caseDocuments.key, key),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!link) throw notFound("Case document not found");
    const revisions = await db
      .select()
      .from(documentRevisions)
      .where(and(
        eq(documentRevisions.companyId, caseRow.companyId),
        eq(documentRevisions.documentId, link.documentId),
      ))
      .orderBy(desc(documentRevisions.revisionNumber));
    const [agentNames, issueMap] = await Promise.all([
      resolveAgentNames(db, revisions.map((rev) => rev.createdByAgentId)),
      resolveIssuesForRuns(db, caseRow.companyId, revisions.map((rev) => rev.createdByRunId)),
    ]);
    res.json({
      key,
      document: {
        id: link.document.id,
        title: link.document.title,
        format: link.document.format,
        latestRevisionId: link.document.latestRevisionId,
        latestRevisionNumber: link.document.latestRevisionNumber,
      },
      revisions: revisions.map((rev) => ({
        id: rev.id,
        revisionNumber: rev.revisionNumber,
        title: rev.title,
        format: rev.format,
        body: rev.body,
        changeSummary: rev.changeSummary,
        createdAt: rev.createdAt,
        createdByAgentId: rev.createdByAgentId,
        createdByUserId: rev.createdByUserId,
        createdByRunId: rev.createdByRunId,
        actorAgentName: rev.createdByAgentId ? agentNames.get(rev.createdByAgentId) ?? null : null,
        issue: rev.createdByRunId ? issueMap.get(rev.createdByRunId) ?? null : null,
      })),
    });
  });

  router.get("/issues/:issueId/cases", async (req, res) => {
    await assertCasesEnabled(db);
    const issueIdOrIdentifier = (req.params.issueId as string).trim();
    const issue = await loadIssueByIdOrIdentifier(db, issueIdOrIdentifier, caseLookupCompanyIds(req));
    if (!issue || !hasCompanyAccess(req, issue.companyId)) throw notFound("Issue not found");
    assertCompanyAccess(req, issue.companyId);
    const rows = await db
      .select({ link: caseIssueLinks, caseRow: cases })
      .from(caseIssueLinks)
      .innerJoin(cases, eq(caseIssueLinks.caseId, cases.id))
      .where(and(eq(caseIssueLinks.companyId, issue.companyId), eq(caseIssueLinks.issueId, issue.id)))
      .orderBy(asc(caseIssueLinks.createdAt));
    res.json(rows.map((row) => ({
      id: row.link.id,
      role: row.link.role,
      createdAt: row.link.createdAt,
      case: {
        id: row.caseRow.id,
        identifier: row.caseRow.identifier,
        title: row.caseRow.title,
        caseType: row.caseRow.caseType,
        status: row.caseRow.status,
      },
    })));
  });

  router.get("/cases/:id", async (req, res, next) => {
    const row = await resolveSharedPathCase(db, req, req.params.id as string);
    if (!row) return next();
    res.json(await loadCaseDetail(db, row));
  });

  router.patch("/cases/:id", async (req, res, next) => {
    const caseRow = await resolveSharedPathCase(db, req, req.params.id as string);
    if (!caseRow) return next();
    const actor = getActorInfo(req);
    const body = patchCaseSchema.parse(req.body);
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
      const [row] = await tx.update(cases).set(buildCasePatchUpdateValues(body, caseRow, now)).where(eq(cases.id, caseRow.id)).returning();

      if (nextLabelIds) {
        await lockCaseLabels(tx, { companyId: caseRow.companyId, caseId: caseRow.id });
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
