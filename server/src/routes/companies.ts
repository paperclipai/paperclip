import { createHash, randomUUID } from "node:crypto";
import express, { Router, type Request, type Response } from "express";
import multer from "multer";
import { and, count as countFn, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { agents as agentsTable } from "@paperclipai/db";
import type { CompanyPortabilityImportResult } from "@paperclipai/shared";
import {
  MAX_ZIP_ENTRY_DECOMPRESSED_BYTES,
  MAX_ZIP_TOTAL_DECOMPRESSED_BYTES,
  readZipArchive,
} from "@paperclipai/shared/portability-zip";
import {
  DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION,
  companyArtifactsQuerySchema,
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
import {
  COMPANY_IMPORT_TRANSFERS_ROUTE_PATH,
  companyImportTransferDeclarationSchema,
  type CompanyImportTransferCreated,
  type CompanyImportTransferDeclaration,
  type CompanyImportTransferPartUploadResult,
  type CompanyImportTransferStatus,
} from "@paperclipai/shared/company-import-transfer";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { PORTABLE_ZIP_UPLOAD_LIMIT_BYTES } from "../http/body-limits.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import {
  assembleImportTransferZip,
  importTransferPartName,
  importTransferPartSizeOnDisk,
  isImportTransferRunId,
  removeImportTransferPart,
  removeImportTransferSpool,
  resolveDefaultImportTransferSpoolRoot,
  writeImportTransferPart,
} from "../services/company-import-transfers.js";
import { companyTransferRunService } from "../services/company-transfer-runs.js";
import {
  accessService,
  agentService,
  budgetService,
  buildExportFidelityReport,
  collectExportFidelityCounts,
  companyArtifactsService,
  companyPortabilityService,
  companyService,
  feedbackService,
  logActivity,
  workTimelineService,
} from "../services/index.js";
import { isCloudManagedInstance } from "../services/cloud-instance.js";
import type { StorageService } from "../storage/types.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";
import { COMPANY_IMPORT_ROUTE_PATH } from "./company-import-paths.js";

// A company import can arrive one of two ways on the import + preview routes:
//   • application/json — the original inline body `{ source, target, ... }`,
//     kept byte-identical for CLI and programmatic callers; or
//   • the raw compressed zip, either as multipart/form-data (a `package` file
//     field plus a JSON `meta` field) or a bare application/zip body. The zip
//     is a third of the inline size and already gzip-friendly, so it survives
//     the browser → edge → harness-proxy → tenant chain that truncated the
//     inflated inline JSON on large companies.
// The zip is unzipped server-side into the exact `{ rootPath, files }` bundle
// the inline source carries, then fed through the unchanged preview/import
// logic, so import semantics are identical regardless of transport.
const PORTABLE_ZIP_CONTENT_TYPES = ["application/zip", "application/x-zip-compressed"] as const;

const zipPackageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PORTABLE_ZIP_UPLOAD_LIMIT_BYTES, files: 1 },
});

// Chunked resumable variant of the zip upload above: the client slices the
// exact same .zip into byte-range parts and uploads them individually, so a
// dropped connection re-uploads one part instead of the whole package. Parts
// are spooled to disk and reassembled at apply, then fed through the same
// preview/import logic — no new container format, no change to import
// semantics. Only one part is held in memory at a time during upload; the
// full-zip buffer exists only while an apply runs (matching the single-shot
// path's memory profile).
const IMPORT_TRANSFER_PART_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

// The declaration body and response shapes are the shared wire contract in
// @paperclipai/shared/company-import-transfer — the browser and CLI clients
// type against the same schemas and path builders.
const importTransferManifestSchema = companyImportTransferDeclarationSchema;

type ImportTransferManifest = CompanyImportTransferDeclaration;

const importTransferPartBodyParser = express.raw({
  type: () => true,
  limit: IMPORT_TRANSFER_PART_SIZE_LIMIT_BYTES,
});

const rawZipBodyParser = express.raw({
  type: [...PORTABLE_ZIP_CONTENT_TYPES],
  limit: PORTABLE_ZIP_UPLOAD_LIMIT_BYTES,
});

function requestContentType(req: Request) {
  return (req.header("content-type") ?? "").toLowerCase();
}

function isMultipartImport(req: Request) {
  return requestContentType(req).includes("multipart/form-data");
}

function isZipImport(req: Request) {
  const contentType = requestContentType(req);
  return PORTABLE_ZIP_CONTENT_TYPES.some((type) => contentType.includes(type));
}

function runMiddleware(
  middleware: (req: Request, res: Response, next: (err?: unknown) => void) => void,
  req: Request,
  res: Response,
) {
  return new Promise<void>((resolve, reject) => {
    middleware(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
  });
}

/**
 * Parse the `meta` form/query field into the object the import schemas expect.
 * A client-declared `source` is ignored — the source is always the uploaded
 * zip — so a multipart caller only ships the other import fields (include,
 * target, collisionStrategy, nameOverrides, selectedFiles, adapterOverrides,
 * pauseAutomations, ...).
 */
function parseImportMeta(metaRaw: string | undefined): Record<string, unknown> {
  if (metaRaw === undefined || metaRaw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(metaRaw);
  } catch {
    throw badRequest("Import package metadata was not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw badRequest("Import package metadata must be a JSON object.");
  }
  const { source: _ignoredSource, ...rest } = parsed as Record<string, unknown>;
  return rest;
}

/**
 * The chunked-transfer apply body is the already-parsed JSON equivalent of the
 * multipart `meta` field: the import fields minus `source` (the source is
 * always the assembled zip). Mirrors `parseImportMeta` for object bodies.
 */
function importTransferApplyMeta(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("Import transfer apply body must be a JSON object.");
  }
  const { source: _ignoredSource, ...rest } = body as Record<string, unknown>;
  return rest;
}

/**
 * Resolve the object to hand the preview/import zod schemas. For a JSON request
 * this is the inline body unchanged. For a multipart or application/zip request
 * the uploaded zip is read into `{ rootPath, files }` and combined with the
 * `meta` fields as `source = { type: "inline", rootPath, files }`. A truncated,
 * corrupt, or empty zip fails closed with a 400/422 before anything is imported.
 */
async function resolveImportPayload(req: Request, res: Response): Promise<unknown> {
  const multipart = isMultipartImport(req);
  const rawZip = isZipImport(req);
  if (!multipart && !rawZip) {
    return req.body;
  }

  let zipBytes: Buffer | undefined;
  let metaRaw: string | undefined;
  if (multipart) {
    try {
      await runMiddleware(zipPackageUpload.single("package"), req, res);
    } catch (error) {
      if (error instanceof multer.MulterError) {
        if (error.code === "LIMIT_FILE_SIZE") {
          throw unprocessable(
            `Import package exceeds the ${Math.floor(PORTABLE_ZIP_UPLOAD_LIMIT_BYTES / (1024 * 1024))} MB upload limit`,
          );
        }
        throw badRequest(error.message);
      }
      throw error;
    }
    const file = (req as Request & { file?: { buffer?: Buffer } }).file;
    zipBytes = file?.buffer;
    const metaField = (req.body as { meta?: unknown } | undefined)?.meta;
    metaRaw = typeof metaField === "string" ? metaField : undefined;
  } else {
    try {
      await runMiddleware(rawZipBodyParser, req, res);
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : "Invalid zip upload");
    }
    zipBytes = Buffer.isBuffer(req.body) ? req.body : undefined;
    const metaQuery = req.query.meta;
    metaRaw = typeof metaQuery === "string" ? metaQuery : undefined;
  }

  if (!zipBytes || zipBytes.length === 0) {
    throw badRequest("Import package upload was empty.");
  }
  const archive = await readImportZipArchive(zipBytes);
  return {
    ...parseImportMeta(metaRaw),
    source: { type: "inline", rootPath: archive.rootPath, files: archive.files },
  };
}

/**
 * Read an uploaded import zip with the scaled bomb guards. Shared by the
 * single-shot upload path (`resolveImportPayload`) and the chunked transfer
 * apply path, so both feed the exact same `{ rootPath, files }` bundle into
 * the unchanged preview/import logic.
 */
async function readImportZipArchive(zipBytes: Buffer) {
  let archive: Awaited<ReturnType<typeof readZipArchive>>;
  try {
    // Scale the bomb guards from the configured upload cap so a legitimately
    // compressible package under the cap never trips them (~4x covers dense
    // text; the per-entry ceiling is bounded by V8's string limit regardless).
    archive = await readZipArchive(zipBytes, {
      maxEntryDecompressedBytes: MAX_ZIP_ENTRY_DECOMPRESSED_BYTES,
      maxTotalDecompressedBytes: Math.max(
        MAX_ZIP_TOTAL_DECOMPRESSED_BYTES,
        PORTABLE_ZIP_UPLOAD_LIMIT_BYTES * 4,
      ),
    });
  } catch (error) {
    throw badRequest(`Import package could not be read: ${errorMessage(error)}`);
  }
  if (Object.keys(archive.files).length === 0) {
    throw badRequest("Import package contained no files.");
  }
  return archive;
}

/**
 * Async job opt-in. Cloud tenants set the `x-paperclip-cloud-async-import`
 * header server-side (they are not a browser, so it is never stripped). Board
 * browsers cannot use that header — the Cloud harness proxy strips every
 * inbound `x-paperclip-cloud-*` header as anti-spoofing — so they opt in with
 * the proxy-safe `?async=1` query parameter instead. Either signal enters the
 * async path.
 */
function wantsAsyncImport(req: Request) {
  return req.query.async === "1" || req.header("x-paperclip-cloud-async-import") === "1";
}

export interface CompanyRoutesOptions {
  /** Overridable in tests; defaults to `<instance root>/import-transfers`. */
  importTransferSpoolRoot?: string;
}

export function companyRoutes(db: Db, storage?: StorageService, options?: CompanyRoutesOptions) {
  const router = Router();
  const importTransferSpoolRoot =
    options?.importTransferSpoolRoot ?? resolveDefaultImportTransferSpoolRoot();
  const svc = companyService(db);
  const agents = agentService(db);
  const portability = companyPortabilityService(db, storage);
  const access = accessService(db);
  const budgets = budgetService(db);
  const artifacts = companyArtifactsService(db, storage);
  const feedback = feedbackService(db);
  const importJobs = new Map<string, ImportJobRecord>();
  // Terminal jobs are retained in memory for an hour after they settle. A long
  // import can outlast a user stepping away, and dropping the completion after
  // only a few minutes made a later poll 404 — surfacing a finished, fully
  // written import as a scary failure. An hour is long enough to cover a real
  // "walk away and come back" gap while keeping the map bounded, and it needs
  // no new persistence (jobs remain in-memory-only; a restart still 404s, which
  // the client now treats as a soft success once it has seen the job running).
  const importJobTerminalRetentionMs = 60 * 60 * 1000;

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

  function parseIntegerQuery(value: unknown, field: string) {
    if (value === undefined || value === null || value === "") return undefined;
    const parsed = typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(parsed)) {
      throw badRequest(`Invalid ${field} query value`);
    }
    return Math.floor(parsed);
  }

  const timelineQuerySchema = z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    userId: z.string().min(1).optional(),
    goalId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    issueId: z.string().uuid().optional(),
    limit: z.string().optional(),
    offset: z.string().optional(),
  }).passthrough();

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

  async function assertSameCompanyCeoAgentOrBoard(req: Request, companyId: string, capability: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      return;
    }
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actorAgent.role !== "ceo") {
      throw forbidden(`Only CEO agents can manage ${capability}`);
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

  router.get("/:companyId/artifacts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = companyArtifactsQuerySchema.parse(req.query);
    res.json(await artifacts.list(companyId, query, {
      userId: query.starred && req.actor.type === "board" ? req.actor.userId : undefined,
    }));
  });

  router.get("/:companyId/timeline", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const companyScopeDecision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (!companyScopeDecision.allowed) {
      res.status(403).json({ error: "Timeline is outside this actor's authorization boundary" });
      return;
    }

    const query = timelineQuerySchema.parse(req.query);
    const timeline = workTimelineService(db);
    const result = await timeline.getTimeline({
      companyId,
      from: parseDateQuery(query.from, "from"),
      to: parseDateQuery(query.to, "to"),
      userId: query.userId,
      goalId: query.goalId,
      projectId: query.projectId,
      issueId: query.issueId,
      limit: parseIntegerQuery(query.limit, "limit"),
      offset: parseIntegerQuery(query.offset, "offset"),
      canReadIssue: async (issue) => {
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
          scope: {
            issueId: issue.id,
            projectId: issue.projectId,
            parentIssueId: issue.parentId,
            assigneeAgentId: issue.assigneeAgentId,
            assigneeUserId: issue.assigneeUserId,
          },
        });
        return decision.allowed;
      },
    });
    res.json(result);
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

  router.post("/:companyId/export", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSameCompanyCeoAgentOrBoard(req, companyId, "company exports");
    const body = companyPortabilityExportSchema.parse(req.body);
    const result = await portability.exportBundle(companyId, body);
    res.json(result);
  });

  router.get("/:companyId/export/fidelity", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSameCompanyCeoAgentOrBoard(req, companyId, "company export fidelity");
    const counts = await collectExportFidelityCounts(db, companyId);
    res.json(buildExportFidelityReport(companyId, counts));
  });

  router.post("/import/preview", async (req, res) => {
    assertBoard(req);
    const body = companyPortabilityPreviewSchema.parse(await resolveImportPayload(req, res));
    assertImportTargetAccess(req, body.target);
    const preview = await portability.previewImport(body);
    res.json(preview);
  });

  router.get("/import/jobs/:jobId", async (req, res) => {
    // Board sessions and trusted Cloud tenants both poll here. A job is
    // readable only by the actor key that created it; every other caller —
    // like every unknown or expired id — gets the same 404, so job ids
    // cannot be probed across users or tenants. Jobs live in memory only
    // (see the async block below), so a restart also surfaces as this 404.
    assertBoard(req);
    cleanupTerminalImportJobs(importJobs, importJobTerminalRetentionMs);
    const job = importJobs.get(req.params.jobId as string);
    if (!job || job.actorKey !== importJobActorKey(req)) {
      res.status(404).json({ error: "Import job not found" });
      return;
    }
    res.json(importJobResponse(job));
  });

  /**
   * Post-resolution import execution, shared by the single-shot upload route
   * and the chunked transfer apply route: validate the resolved body, run the
   * import synchronously or through the in-memory async job machinery, and
   * fire the optional completion hooks (the transfer path uses them to settle
   * its ledger run) on the import's real outcome in either mode.
   */
  async function executeImportRequest(
    req: Request,
    res: Response,
    rawImportBody: unknown,
    hooks?: {
      onSuccess?: (result: CompanyPortabilityImportResult) => Promise<void>;
      /** Fires when the request is refused before any import work starts (e.g. another import is already running for the actor). */
      onConflict?: () => Promise<void>;
      onFailure?: (message: string) => Promise<void>;
    },
  ) {
    const actor = getActorInfo(req);
    const boardUserId = req.actor.type === "board" ? req.actor.userId : null;
    const operation = async () => {
      try {
        const importBody = companyPortabilityImportSchema.parse(rawImportBody);
        assertImportTargetAccess(req, importBody.target);
        const activity = importedCompanyActivityContext(actor, importBody.include ?? null);
        const result = await portability.importBundle(importBody, boardUserId, {
          pauseAutomations: importBody.pauseAutomations === true,
        });
        // The import is committed. Settlement (hooks) runs before the
        // best-effort audit entry so a logging failure cannot make a
        // committed import read as failed — or, on the transfer path, release
        // the apply claim and invite a duplicate re-import.
        await hooks?.onSuccess?.(result);
        try {
          await logImportedCompanyActivity(db, activity, result);
        } catch (activityError) {
          logger.warn(
            { err: activityError, companyId: result.company.id },
            "failed to write the company.imported activity entry for a committed import",
          );
        }
        return result;
      } catch (error) {
        await hooks?.onFailure?.(errorMessage(error));
        throw error;
      }
    };
    if (wantsAsyncImport(req)) {
      // Async job path. Two kinds of callers opt in:
      //  - trusted Cloud tenants (original behavior, kept byte-identical),
      //    keyed by their tenant identity headers;
      //  - any other board session, keyed by its user id, so long imports
      //    survive proxies cutting the connection while the server finishes.
      // Jobs are held in memory only and are lost on restart — existing
      // semantics; the status route above 404s unknown ids, so a client
      // that can no longer see its job treats it as gone and resubmits.
      cleanupTerminalImportJobs(importJobs, importJobTerminalRetentionMs);
      const isCloudTenant = req.actor.source === "cloud_tenant";
      const actorKey = importJobActorKey(req);
      const signature = importRequestSignature(rawImportBody);
      if (!isCloudTenant) {
        // One live import per board actor: while a job for this key is still
        // running, a resubmit of the *same* import gets 409 carrying the
        // running job's id and status URL so the client adopts it instead of
        // importing the same bundle twice. A *different* import (another tab,
        // another target) gets a 409 without a job to adopt, so the client
        // surfaces it as an error rather than switching to the wrong result.
        // Terminal jobs never block a resubmit.
        const running = findRunningImportJob(importJobs, actorKey);
        if (running) {
          // No import work starts on this path, so a caller holding a claim
          // (the transfer apply) must be told to release it — otherwise the
          // refused transfer would sit in "applying" until a restart.
          await hooks?.onConflict?.();
          if (running.signature === signature) {
            res.status(409).json(importJobConflictResponse(running));
          } else {
            res.status(409).json(importAlreadyRunningResponse());
          }
          return;
        }
      }
      const job = createImportJob(
        actorKey,
        isCloudTenant ? "cloud_tenant" : "board",
        signature,
      );
      importJobs.set(job.id, job);
      res.status(202).json(importJobAcceptedResponse(job));
      setImmediate(() => {
        void runImportJob(job, operation);
      });
      return;
    }

    const result = await operation();
    res.json(result);
  }

  router.post(COMPANY_IMPORT_ROUTE_PATH, async (req, res) => {
    assertBoard(req);
    // Resolve the request body up front: a JSON caller's inline body is used
    // unchanged; a multipart/application-zip caller's uploaded zip is read into
    // the same `{ source: { type: "inline", rootPath, files } }` bundle here,
    // fast and in-memory, so the async job machinery below is transport-agnostic.
    const rawImportBody: unknown = await resolveImportPayload(req, res);
    await executeImportRequest(req, res, rawImportBody);
  });

  /**
   * Load the transfer run for the URL's id, scoped to the caller the same way
   * import jobs are (`importJobActorKey`): an unknown id, another actor's id,
   * and a non-import run are all the same 404, so transfer ids cannot be
   * probed across users or tenants. The id is regex-validated as a UUID before
   * it is used anywhere (it is later joined into spool paths).
   */
  async function requireImportTransferRun(req: Request) {
    const transferId = req.params.transferId as string;
    if (!isImportTransferRunId(transferId)) {
      throw notFound("Import transfer not found");
    }
    const run = await companyTransferRunService.getRunForActor(db, transferId, importJobActorKey(req));
    if (!run || run.direction !== "import") {
      throw notFound("Import transfer not found");
    }
    return run;
  }

  /** The declared part list persisted on the run at create time. */
  function storedImportTransferManifest(run: { manifest: unknown }): ImportTransferManifest {
    const parsed = importTransferManifestSchema.safeParse(run.manifest);
    if (!parsed.success) {
      throw conflict("Import transfer has no recorded part manifest");
    }
    return parsed.data;
  }

  /**
   * Indexes the client still has to upload. A part counts as done only when
   * the ledger recorded it AND its spool file is still on disk at the declared
   * size — so a swept or damaged spool surfaces as missing parts to re-upload
   * instead of a failing apply.
   */
  async function importTransferMissingParts(
    run: { id: string; completedParts: string[] },
    manifest: ImportTransferManifest,
  ): Promise<number[]> {
    const completed = new Set(run.completedParts);
    const missing: number[] = [];
    for (const part of manifest.parts) {
      if (!completed.has(importTransferPartName(part.index))) {
        missing.push(part.index);
        continue;
      }
      const sizeOnDisk = await importTransferPartSizeOnDisk(importTransferSpoolRoot, run.id, part.index);
      if (sizeOnDisk !== part.byteSize) {
        missing.push(part.index);
      }
    }
    return missing;
  }

  // Declare a chunked import transfer. The declaration is content-addressed:
  // the idempotency key derives from the whole-zip hash plus every part hash,
  // so re-declaring the same zip resumes the prior run (with its uploaded
  // parts intact) instead of starting over.
  router.post(COMPANY_IMPORT_TRANSFERS_ROUTE_PATH, async (req, res) => {
    assertBoard(req);
    const declared = importTransferManifestSchema.parse(req.body);
    if (declared.totalBytes > PORTABLE_ZIP_UPLOAD_LIMIT_BYTES) {
      throw unprocessable(
        `Import package exceeds the ${Math.floor(PORTABLE_ZIP_UPLOAD_LIMIT_BYTES / (1024 * 1024))} MB upload limit`,
      );
    }
    if (declared.partSizeBytes > IMPORT_TRANSFER_PART_SIZE_LIMIT_BYTES) {
      throw unprocessable(
        `Import transfer parts may be at most ${Math.floor(IMPORT_TRANSFER_PART_SIZE_LIMIT_BYTES / (1024 * 1024))} MB`,
      );
    }
    declared.parts.forEach((part, position) => {
      if (part.index !== position) {
        throw unprocessable("Import transfer parts must be contiguous, ordered 0..n-1");
      }
      if (part.byteSize > declared.partSizeBytes) {
        throw unprocessable(`Part ${part.index} is larger than the declared partSizeBytes`);
      }
    });
    const declaredTotal = declared.parts.reduce((sum, part) => sum + part.byteSize, 0);
    if (declaredTotal !== declared.totalBytes) {
      throw unprocessable("Sum of part byte sizes must equal totalBytes");
    }

    const idempotencyKey = createHash("sha256")
      .update(JSON.stringify([declared.zipSha256, declared.parts.map((part) => part.sha256)]))
      .digest("hex");
    const { run, alreadyCompleted } = await companyTransferRunService.resumeOrCreate(db, {
      direction: "import",
      actorKey: importJobActorKey(req),
      idempotencyKey,
      containerRef: { kind: "chunked_zip_upload" },
    });
    if (alreadyCompleted) {
      res.json({
        transferId: run.id,
        status: "completed",
        alreadyCompleted: true,
        totalParts: declared.parts.length,
        missingParts: [],
      } satisfies CompanyImportTransferCreated);
      return;
    }
    if (run.manifest === null || run.manifest === undefined) {
      const manifestSha256 = createHash("sha256").update(JSON.stringify(declared)).digest("hex");
      await companyTransferRunService.recordManifest(db, run.id, declared, manifestSha256, {
        chunkCount: declared.parts.length,
        blobCount: 0,
      });
    }
    await companyTransferRunService.start(db, run.id);
    res.json({
      transferId: run.id,
      status: "running",
      alreadyCompleted: false,
      totalParts: declared.parts.length,
      missingParts: await importTransferMissingParts(run, declared),
    } satisfies CompanyImportTransferCreated);
  });

  // Upload one declared part as a raw body. Verified against the declared
  // size and sha256 before it is spooled; re-uploading an already completed
  // part is a no-op success, so clients can blindly retry.
  router.put(
    `${COMPANY_IMPORT_TRANSFERS_ROUTE_PATH}/:transferId/parts/:partIndex`,
    importTransferPartBodyParser,
    async (req, res) => {
      assertBoard(req);
      const run = await requireImportTransferRun(req);
      if (run.status === "completed") {
        throw conflict("Import transfer has already been applied");
      }
      if (run.status === "applying") {
        // An apply is assembling the spool right now; accepting writes would
        // let a retried upload race the files being read. Parts are frozen
        // until the apply settles (completed short-circuits, failed resumes).
        throw conflict("Import transfer apply is in progress; retry after it settles");
      }
      const manifest = storedImportTransferManifest(run);
      const rawIndex = req.params.partIndex as string;
      // Strict integer-in-bounds validation before the index goes anywhere
      // near a filesystem path.
      if (!/^\d{1,5}$/.test(rawIndex) || Number(rawIndex) >= manifest.parts.length) {
        throw notFound("Import transfer part not found");
      }
      const partIndex = Number(rawIndex);
      const declared = manifest.parts[partIndex]!;
      const partName = importTransferPartName(partIndex);
      if (run.completedParts.includes(partName)) {
        const sizeOnDisk = await importTransferPartSizeOnDisk(importTransferSpoolRoot, run.id, partIndex);
        if (sizeOnDisk === declared.byteSize) {
          res.json({ ok: true, index: partIndex, alreadyCompleted: true } satisfies CompanyImportTransferPartUploadResult);
          return;
        }
      }
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (bytes.length !== declared.byteSize) {
        throw unprocessable(
          `Part ${partIndex} upload is ${bytes.length} bytes but was declared as ${declared.byteSize} bytes`,
        );
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== declared.sha256) {
        throw unprocessable(`Part ${partIndex} content does not match its declared sha256`);
      }
      await writeImportTransferPart(importTransferSpoolRoot, run.id, partIndex, bytes);
      const recorded = await companyTransferRunService.completePart(db, run.id, partName);
      if (!recorded) {
        // The run left pending/running between the load above and this
        // record. Which way it went decides the file's fate: under a claimed
        // or completed apply the just-written bytes are hash-verified
        // identical to what the apply assembles, so the file must NOT be
        // deleted out from under it; a swept or failed run is dead, so the
        // stray part is dropped and the client told to re-create.
        const current = await companyTransferRunService.getRun(db, run.id);
        if (current?.status === "applying" || current?.status === "completed") {
          throw conflict("Import transfer apply is in progress; retry after it settles");
        }
        await removeImportTransferPart(importTransferSpoolRoot, run.id, partIndex);
        res.status(410).json({ error: "Import transfer expired — re-create it" });
        return;
      }
      res.json({ ok: true, index: partIndex, alreadyCompleted: false } satisfies CompanyImportTransferPartUploadResult);
    },
  );

  // Resume polling: which parts are done, which are still missing.
  router.get(`${COMPANY_IMPORT_TRANSFERS_ROUTE_PATH}/:transferId`, async (req, res) => {
    assertBoard(req);
    const run = await requireImportTransferRun(req);
    const manifest = storedImportTransferManifest(run);
    const missingParts = run.status === "completed" ? [] : await importTransferMissingParts(run, manifest);
    res.json({
      transferId: run.id,
      status: run.status,
      totalParts: manifest.parts.length,
      completedParts: manifest.parts.length - missingParts.length,
      missingParts,
    } satisfies CompanyImportTransferStatus);
  });

  // Assemble the spooled parts back into the original zip, verify it against
  // the declared whole-file hash, and run it through the exact import path a
  // single-shot zip upload takes. The body carries the same meta fields the
  // multipart route's `meta` field does (include/target/collisionStrategy/...).
  router.post(`${COMPANY_IMPORT_TRANSFERS_ROUTE_PATH}/:transferId/apply`, async (req, res) => {
    assertBoard(req);
    const run = await requireImportTransferRun(req);
    if (run.status === "completed") {
      throw conflict("Import transfer has already been applied");
    }
    const manifest = storedImportTransferManifest(run);
    const missingParts = await importTransferMissingParts(run, manifest);
    if (missingParts.length > 0) {
      res.status(409).json({
        error: "Import transfer is missing parts",
        missingParts,
      });
      return;
    }
    // Atomic claim: the import pipeline is not idempotent, so of any
    // overlapping applies of this transfer exactly one may run it. The claim
    // is a single guarded status flip to "applying"; complete() or the
    // guarded releaseApplyClaim() below settle it (a released run stays
    // retryable). Losers get 409.
    if (!(await companyTransferRunService.claimApply(db, run.id))) {
      throw conflict("Import transfer apply is already in progress");
    }
    try {
      const zipBytes = await assembleImportTransferZip(importTransferSpoolRoot, run.id, manifest.parts.length);
      const zipSha256 = createHash("sha256").update(zipBytes).digest("hex");
      if (zipBytes.length !== manifest.totalBytes || zipSha256 !== manifest.zipSha256) {
        // Fail closed: every part verified individually but the whole does not
        // match the declaration. The spool is deleted so a resume re-uploads
        // every part instead of re-assembling the same corrupt bytes.
        await companyTransferRunService.fail(db, run.id, "Assembled import package failed whole-file verification");
        await removeImportTransferSpool(importTransferSpoolRoot, run.id);
        throw unprocessable("Assembled import package failed verification; upload the transfer again");
      }
      const archive = await readImportZipArchive(zipBytes);
      const meta = importTransferApplyMeta(req.body);
      const rawImportBody = {
        ...meta,
        source: { type: "inline", rootPath: archive.rootPath, files: archive.files },
      };
      await executeImportRequest(req, res, rawImportBody, {
        onSuccess: async (result) => {
          // Settle the run the moment the import is committed: every later
          // step is best-effort, because any error escaping this hook reads
          // as a failed apply and — before complete() — would release the
          // claim on an already-committed import. complete() gets one retry;
          // if both attempts fail the run is left "applying" (unclaimable, so
          // no duplicate import) and logged for the operator; a restart's
          // stranded-run recovery then makes it inspectable as failed.
          try {
            await companyTransferRunService.complete(db, run.id);
          } catch {
            try {
              await companyTransferRunService.complete(db, run.id);
            } catch (settleError) {
              logger.error(
                { err: settleError, transferId: run.id },
                "import committed but the transfer run could not be marked completed",
              );
              return;
            }
          }
          try {
            await companyTransferRunService.attachCompany(db, run.id, result.company.id);
          } catch (attachError) {
            logger.warn(
              { err: attachError, transferId: run.id },
              "failed to attach the imported company to its transfer run",
            );
          }
          // Best-effort cleanup: the import is committed and the run is
          // completed, so a spool deletion error must not escape — it would
          // reach the failure paths below and read as a failed apply. The
          // leftover dir is harmless (completed runs never assemble again)
          // and the sweep collects terminal-run spools immediately.
          try {
            await removeImportTransferSpool(importTransferSpoolRoot, run.id);
          } catch (cleanupError) {
            logger.warn(
              { err: cleanupError, transferId: run.id },
              "failed to delete import transfer spool after a successful apply",
            );
          }
        },
        onFailure: async (message) => {
          // Parts remain spooled: the failure is in the import itself, not
          // the upload, so a retry of apply can reuse the verified parts.
          // Guarded release, not a blind fail: this hook also fires when an
          // error escapes onSuccess above, i.e. possibly after complete(),
          // and a completed run must never be flipped back to claimable.
          await companyTransferRunService.releaseApplyClaim(db, run.id, message);
        },
        onConflict: async () => {
          // The request was refused before any import work (another import is
          // running for this actor): release the claim so the transfer stays
          // retryable instead of stranded in "applying" until a restart.
          await companyTransferRunService.releaseApplyClaim(
            db,
            run.id,
            "another import is already running for this actor",
          );
        },
      });
    } catch (error) {
      // Whatever escapes here (bad meta, malformed zip, an import error
      // rethrown after onFailure) must not leave the run parked in
      // "applying": release the claim, which keeps the run retryable. The
      // release is guarded on "applying", so a run that already settled —
      // failed by onFailure, or completed before a late error — keeps its
      // terminal state.
      await companyTransferRunService.releaseApplyClaim(db, run.id, errorMessage(error));
      throw error;
    }
  });

  router.post("/:companyId/exports/preview", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSameCompanyCeoAgentOrBoard(req, companyId, "company exports");
    const body = companyPortabilityExportSchema.parse(req.body);
    const preview = await portability.previewExport(companyId, body);
    res.json(preview);
  });

  router.post("/:companyId/exports", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSameCompanyCeoAgentOrBoard(req, companyId, "company exports");
    const body = companyPortabilityExportSchema.parse(req.body);
    const result = await portability.exportBundle(companyId, body);
    res.json(result);
  });

  router.post("/:companyId/imports/preview", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSameCompanyCeoAgentOrBoard(req, companyId, "company imports");
    const body = companyPortabilityPreviewSchema.parse(req.body);
    if (body.target.mode === "existing_company" && body.target.companyId !== companyId) {
      throw forbidden("Safe import route can only target the route company");
    }
    if (body.collisionStrategy === "replace") {
      throw forbidden("Safe import route does not allow replace collision strategy");
    }
    const preview = await portability.previewImport(body, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    res.json(preview);
  });

  router.post("/:companyId/imports/apply", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSameCompanyCeoAgentOrBoard(req, companyId, "company imports");
    const body = companyPortabilityImportSchema.parse(req.body);
    if (body.target.mode === "existing_company" && body.target.companyId !== companyId) {
      throw forbidden("Safe import route can only target the route company");
    }
    if (body.collisionStrategy === "replace") {
      throw forbidden("Safe import route does not allow replace collision strategy");
    }
    const actor = getActorInfo(req);
    const result = await portability.importBundle(body, req.actor.type === "board" ? req.actor.userId : null, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
      pauseAutomations: body.pauseAutomations === true,
    });
    await logActivity(db, {
      companyId: result.company.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      entityType: "company",
      entityId: result.company.id,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "company.imported",
      details: {
        include: body.include ?? null,
        agentCount: result.agents.length,
        warningCount: result.warnings.length,
        companyAction: result.company.action,
        importMode: "agent_safe",
      },
    });
    res.json(result);
  });

  router.post("/", (req, _res, next) => {
    assertBoard(req);
    if (isCloudManagedInstance()) {
      throw forbidden("Company creation is managed by Paperclip Cloud", {
        code: "cloud_managed",
      });
    }
    next();
  }, validate(createCompanySchema), async (req, res) => {
    assertBoard(req);
    if (!(req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)) {
      throw forbidden("Instance admin required");
    }
    const ownerPrincipalId = req.actor.userId ?? "local-board";
    const company = await svc.create({
      ...req.body,
      defaultResponsibleUserId: req.body.defaultResponsibleUserId ?? ownerPrincipalId,
    });
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
    await assertSameCompanyCeoAgentOrBoard(req, companyId, "company settings");

    const actor = getActorInfo(req);
    let body: Record<string, unknown>;

    if (req.actor.type === "agent") {
      body = updateCompanyBrandingSchema.parse(req.body);
    } else {
      body = updateCompanySchema.parse(req.body);
    }

    const existingCompany = await svc.getById(companyId);
    if (!existingCompany) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    if (req.actor.type !== "agent") {
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

    const transitionsToArchived =
      body.status === "archived" && existingCompany.status !== "archived";
    const transitionsArchivedToActive =
      body.status === "active" && existingCompany.status === "archived";
    let transitionsPausedToActiveWithArchivePausedAgents = false;
    if (body.status === "active" && existingCompany.status === "paused") {
      const [archivedPausedCount] = await db
        .select({ value: countFn() })
        .from(agentsTable)
        .where(and(
          eq(agentsTable.companyId, companyId),
          eq(agentsTable.status, "paused"),
          eq(agentsTable.pauseReason, "company_archived"),
        ));
      transitionsPausedToActiveWithArchivePausedAgents =
        Number(archivedPausedCount?.value ?? 0) > 0;
    }
    const lifecycleEventEmittedByService =
      transitionsToArchived ||
      transitionsArchivedToActive ||
      transitionsPausedToActiveWithArchivePausedAgents;

    const company = await svc.update(companyId, body, actor);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    if (!lifecycleEventEmittedByService) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "company.updated",
        entityType: "company",
        entityId: companyId,
        details: body,
      });
    }
    res.json(company);
  });

  router.patch("/:companyId/branding", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSameCompanyCeoAgentOrBoard(req, companyId, "company branding");
    const body = updateCompanyBrandingSchema.parse(req.body);
    const company = await svc.update(companyId, body);
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
      agentApiKeyId: actor.agentApiKeyId,
      action: "company.branding_updated",
      entityType: "company",
      entityId: companyId,
      details: body,
    });
    res.json(company);
  });

  router.post("/:companyId/archive", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const company = await svc.archive(companyId, getActorInfo(req));
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(company);
  });

  router.delete("/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const company = await svc.remove(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}

type CompanyImportResult = {
  company: { id: string; action: unknown };
  agents: unknown[];
  warnings: unknown[];
};

type ImportJobActorKind = "cloud_tenant" | "board";

/**
 * In-memory only: import jobs do not survive a server restart, and terminal
 * jobs are dropped after `importJobTerminalRetentionMs`. Both cases surface
 * to pollers as the status route's 404 for an unknown id.
 */
interface ImportJobRecord {
  id: string;
  /** Identity that created the job; the only key allowed to read it. */
  actorKey: string;
  actorKind: ImportJobActorKind;
  /**
   * Fingerprint of the import request body. A resubmit is adopted (409 →
   * watch the running job) only when it carries the same signature, so a
   * *different* import from another tab is rejected instead of silently
   * adopting an unrelated job (and its target). Board jobs only.
   */
  signature?: string;
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
  /**
   * Full import result, retained for board-created jobs only so the import
   * page can run the same success path as the synchronous response. Cloud
   * tenant job responses keep their original summary-only shape.
   */
  fullResult?: CompanyPortabilityImportResult;
}

interface ImportedCompanyActivityContext {
  actorType: "user" | "agent";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  include: unknown;
}

function cloudTenantRequestKey(req: Request) {
  return [
    req.actor.userId ?? "",
    req.header("x-paperclip-cloud-stack-id")?.trim() ?? "",
    req.header("x-paperclip-cloud-paperclip-company-id")?.trim() ?? "",
  ].join(":");
}

/**
 * Identity a job is created under and authorized against. Cloud tenant
 * callers keep their header-derived tenant key; every other board session is
 * keyed by its user id. The distinct prefixes keep the two namespaces
 * disjoint, so crafted tenant headers can never collide with a board key.
 */
function importJobActorKey(req: Request) {
  if (req.actor.source === "cloud_tenant") {
    return `cloud-tenant:${cloudTenantRequestKey(req)}`;
  }
  return `board:${req.actor.userId ?? "local-board"}`;
}

function createImportJob(
  actorKey: string,
  actorKind: ImportJobActorKind,
  signature?: string,
): ImportJobRecord {
  const now = new Date().toISOString();
  return {
    // Cloud tenant job ids keep their original prefix; board jobs get their own.
    id: `${actorKind === "cloud_tenant" ? "tenant-import" : "import"}-${randomUUID()}`,
    actorKey,
    actorKind,
    signature,
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Stable fingerprint of an import request body. The same client resubmitting
 * the same import produces a byte-identical body (no nonce/timestamp), so its
 * signature matches; a different import differs. Used to tell a duplicate
 * submit apart from a concurrent, unrelated import.
 */
function importRequestSignature(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body) ?? "").digest("hex");
}

function findRunningImportJob(importJobs: Map<string, ImportJobRecord>, actorKey: string) {
  for (const job of importJobs.values()) {
    if (job.status === "running" && job.actorKey === actorKey) {
      return job;
    }
  }
  return undefined;
}

async function runImportJob(
  job: ImportJobRecord,
  operation: () => Promise<CompanyPortabilityImportResult>,
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
    if (job.actorKind === "board") {
      job.fullResult = result;
    }
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

function importJobStatusUrl(job: ImportJobRecord) {
  return `/api/companies/import/jobs/${encodeURIComponent(job.id)}`;
}

function importJobAcceptedResponse(job: ImportJobRecord) {
  return {
    job: {
      id: job.id,
      status: job.status,
    },
    statusUrl: importJobStatusUrl(job),
    retryAfterMs: 1000,
  };
}

/**
 * 409 body for a concurrent, *different* import while one is already running.
 * Carries no job to adopt, so the client reports it as an error rather than
 * watching (and switching to) an unrelated import's result.
 */
function importAlreadyRunningResponse() {
  return {
    error: "A different import is already running for this account. Wait for it to finish before starting another.",
  };
}

/** 409 body for a duplicate submit: points at the job already running. */
function importJobConflictResponse(job: ImportJobRecord) {
  return {
    error: "An import is already running for this account",
    job: {
      id: job.id,
      status: job.status,
    },
    statusUrl: importJobStatusUrl(job),
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
      // Board jobs additionally carry the full import result (parity with
      // the synchronous response); cloud tenant jobs never set it.
      ...(job.fullResult ? { importResult: job.fullResult } : {}),
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
