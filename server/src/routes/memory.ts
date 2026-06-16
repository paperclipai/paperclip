import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { badRequest, conflict, HttpError, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  memoryService,
  type MemoryBindingRecord,
  type MemoryOperationRecord,
} from "../services/memory/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

const MEMORY_NOT_CONFIGURED_ERROR = "memory_not_configured";

const memoryQuerySchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  topK: z.number().int().min(1).max(20).optional(),
});

const memoryNoteSchema = z.object({
  title: z.string().trim().min(1).max(200).optional().nullable(),
  text: z.string().trim().min(1).max(20_000),
});

const memoryBindingConfigPatchSchema = z
  .object({
    binPath: z.string().trim().min(1).max(1_024).optional(),
    queryTimeoutMs: z.number().int().min(250).max(60_000).optional(),
    captureTimeoutMs: z.number().int().min(250).max(120_000).optional(),
    topK: z.number().int().min(1).max(20).optional(),
    hydrateEnabled: z.boolean().optional(),
    captureRunsEnabled: z.boolean().optional(),
    maxSnippetChars: z.number().int().min(50).max(5_000).optional(),
    maxBundleChars: z.number().int().min(200).max(20_000).optional(),
  })
  .strict();

const updateMemoryBindingSchema = z
  .object({
    enabled: z.boolean().optional(),
    config: memoryBindingConfigPatchSchema.optional(),
  })
  .refine((value) => value.enabled !== undefined || value.config !== undefined, {
    message: "enabled or config is required",
  });

function serializeBinding(binding: MemoryBindingRecord) {
  return {
    id: binding.id,
    key: binding.key,
    provider: binding.provider,
    enabled: binding.enabled,
    config: binding.config ?? {},
  };
}

function serializeOperation(operation: MemoryOperationRecord) {
  return {
    id: operation.id,
    operation: operation.operation,
    hookKind: operation.hookKind,
    intent: operation.intent,
    status: operation.status,
    agentId: operation.agentId,
    issueId: operation.issueId,
    heartbeatRunId: operation.heartbeatRunId,
    usageJson: operation.usageJson,
    errorMessage: operation.errorMessage,
    createdAt: operation.createdAt,
    requestJson: operation.requestJson,
    resultJson: operation.resultJson,
  };
}

export function memoryRoutes(db: Db) {
  const router = Router();
  const svc = memoryService(db);

  function parseLimitQuery(value: unknown): number | undefined {
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || Math.trunc(parsed) < 1) {
      throw badRequest("Invalid limit query value");
    }
    return Math.trunc(parsed);
  }

  function parseBeforeQuery(value: unknown): Date | undefined {
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw badRequest("Invalid before query value");
    }
    return parsed;
  }

  router.get("/companies/:companyId/memory/overview", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const overview = await svc.getOverview(companyId);
    res.json({
      binding: overview.binding ? serializeBinding(overview.binding) : null,
      providerAvailable: overview.providerAvailable,
      stats: overview.stats,
    });
  });

  router.get("/companies/:companyId/memory/operations", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const items = await svc.listOperations(companyId, {
      limit: parseLimitQuery(req.query.limit),
      before: parseBeforeQuery(req.query.before),
    });
    res.json({ items: items.map(serializeOperation) });
  });

  router.post(
    "/companies/:companyId/memory/query",
    validate(memoryQuerySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.queryForOperator({
        companyId,
        query: req.body.query,
        topK: req.body.topK,
      });
      if (result.error === MEMORY_NOT_CONFIGURED_ERROR) {
        throw conflict("Memory is not configured for this company");
      }
      if (result.error) {
        throw new HttpError(500, `Memory query failed: ${result.error}`);
      }
      res.json({
        snippets: result.snippets.map((snippet) => ({
          slug: snippet.slug,
          title: snippet.title ?? null,
          score: snippet.score ?? null,
          text: snippet.text,
        })),
        latencyMs: result.latencyMs,
      });
    },
  );

  router.post(
    "/companies/:companyId/memory/note",
    validate(memoryNoteSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      // memory.note_created activity is logged inside the service with this actor.
      const result = await svc.noteForOperator({
        companyId,
        title: req.body.title ?? null,
        text: req.body.text,
        actorUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      if (result.error === MEMORY_NOT_CONFIGURED_ERROR) {
        throw conflict("Memory is not configured for this company");
      }
      if (result.error || !result.slug) {
        throw new HttpError(500, `Memory note failed: ${result.error ?? "unknown error"}`);
      }
      res.status(201).json({ slug: result.slug });
    },
  );

  router.patch(
    "/companies/:companyId/memory/binding",
    validate(updateMemoryBindingSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      // memory.binding_updated activity is logged inside the service with this actor.
      const binding = await svc.updateBinding(
        companyId,
        { enabled: req.body.enabled, config: req.body.config },
        { actorUserId: actor.actorType === "user" ? actor.actorId : null },
      );
      if (!binding) {
        throw notFound("Memory binding not found");
      }
      res.json(serializeBinding(binding));
    },
  );

  return router;
}
