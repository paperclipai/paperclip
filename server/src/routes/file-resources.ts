import { Router } from "express";
import { ZodError } from "zod";
import type { Db } from "@paperclipai/db";
import {
  workspaceFileListQuerySchema,
  workspaceFileResourceQuerySchema,
  type ResolvedWorkspaceResource,
  type WorkspaceFileContent,
  type WorkspaceFileListResponse,
} from "@paperclipai/shared";
import { HttpError, unprocessable } from "../errors.js";
import { workspaceFileResourceService } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { logActivity } from "../services/activity-log.js";

export type WorkspaceFileResourceService = {
  getIssue(issueId: string): Promise<{ companyId: string }>;
  list(issueId: string, input: {
    workspace?: "auto" | "execution" | "project" | null;
    projectId?: string | null;
    workspaceId?: string | null;
    path?: string | null;
    mode?: "all" | "recent" | "changed" | null;
    q?: string | null;
    limit?: number | null;
    offset?: number | null;
  }, opts?: { issue?: Awaited<ReturnType<WorkspaceFileResourceService["getIssue"]>> }): Promise<WorkspaceFileListResponse>;
  resolve(
    issueId: string,
    input: { path: string; workspace?: "auto" | "execution" | "project" | null; projectId?: string | null; workspaceId?: string | null },
    opts?: { issue?: Awaited<ReturnType<WorkspaceFileResourceService["getIssue"]>> },
  ): Promise<ResolvedWorkspaceResource>;
  readContent(
    issueId: string,
    input: { path: string; workspace?: "auto" | "execution" | "project" | null; projectId?: string | null; workspaceId?: string | null },
    opts?: { issue?: Awaited<ReturnType<WorkspaceFileResourceService["getIssue"]>> },
  ): Promise<WorkspaceFileContent>;
};

type FileResourceLimiter = {
  acquire(key: string): () => void;
};

export function createFileResourceLimiter(opts: {
  maxConcurrent?: number;
  maxRequests?: number;
  windowMs?: number;
  requestLimitMessage?: string;
  concurrencyLimitMessage?: string;
} = {}): FileResourceLimiter {
  const maxConcurrent = opts.maxConcurrent ?? 6;
  const maxRequests = opts.maxRequests ?? 120;
  const windowMs = opts.windowMs ?? 60_000;
  const requestLimitMessage = opts.requestLimitMessage ?? "Too many file preview requests";
  const concurrencyLimitMessage = opts.concurrencyLimitMessage ?? "Too many concurrent file preview requests";
  const activeByKey = new Map<string, number>();
  const windowsByKey = new Map<string, { startedAt: number; count: number }>();

  return {
    acquire(key: string) {
      const now = Date.now();
      for (const [windowKey, existing] of windowsByKey) {
        if (now - existing.startedAt >= windowMs) windowsByKey.delete(windowKey);
      }
      const window = windowsByKey.get(key);
      if (!window || now - window.startedAt >= windowMs) {
        windowsByKey.set(key, { startedAt: now, count: 1 });
      } else {
        window.count += 1;
        if (window.count > maxRequests) {
          throw new HttpError(429, requestLimitMessage, { code: "rate_limited" });
        }
      }

      const active = activeByKey.get(key) ?? 0;
      if (active >= maxConcurrent) {
        throw new HttpError(429, concurrencyLimitMessage, { code: "concurrency_limited" });
      }
      activeByKey.set(key, active + 1);
      return () => {
        const current = activeByKey.get(key) ?? 0;
        if (current <= 1) activeByKey.delete(key);
        else activeByKey.set(key, current - 1);
      };
    },
  };
}

export function createFileResourceListLimiter(opts: {
  maxConcurrent?: number;
  maxRequests?: number;
  windowMs?: number;
} = {}): FileResourceLimiter {
  return createFileResourceLimiter({
    maxConcurrent: opts.maxConcurrent ?? 2,
    maxRequests: opts.maxRequests ?? 30,
    windowMs: opts.windowMs,
    requestLimitMessage: "Too many workspace file list requests",
    concurrencyLimitMessage: "Too many concurrent workspace file list requests",
  });
}

function limiterKey(companyId: string, actorId: string, issueId: string) {
  return `${companyId}:${actorId}:${issueId}`;
}

function readQuery(query: unknown) {
  let parsed;
  try {
    parsed = workspaceFileResourceQuerySchema.parse(query);
  } catch (error) {
    if (error instanceof ZodError) {
      const refinement = error.errors.find((issue) => {
        const code = (issue as { params?: { code?: string } }).params?.code;
        return code === "invalid_path" || code === "invalid_target";
      });
      const code = (refinement as { params?: { code?: string } } | undefined)?.params?.code;
      if (refinement) throw unprocessable(refinement.message, { code: code ?? "invalid_path" });
    }
    throw error;
  }
  return {
    path: parsed.path,
    workspace: parsed.workspace ?? "auto",
    projectId: parsed.projectId ?? null,
    workspaceId: parsed.workspaceId ?? null,
  };
}

function readListQuery(query: unknown) {
  let parsed;
  try {
    parsed = workspaceFileListQuerySchema.parse(query);
  } catch (error) {
    if (error instanceof ZodError) {
      const refinement = error.errors.find((issue) => {
        const code = (issue as { params?: { code?: string } }).params?.code;
        return code === "invalid_query" || code === "invalid_target" || code === "invalid_path";
      });
      const code = (refinement as { params?: { code?: string } } | undefined)?.params?.code;
      if (refinement) throw unprocessable(refinement.message, { code: code ?? "invalid_query" });
      throw unprocessable("Workspace file list query is invalid", { code: "invalid_query" });
    }
    throw error;
  }
  return {
    workspace: parsed.workspace ?? "auto",
    projectId: parsed.projectId ?? null,
    workspaceId: parsed.workspaceId ?? null,
    path: parsed.path ?? null,
    mode: parsed.mode ?? "all",
    q: parsed.q?.trim() || null,
    limit: parsed.limit,
    offset: parsed.offset,
  };
}

function activityDetails(input: {
  outcome: "success" | "denied" | "unavailable";
  workspaceKind?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  displayPath?: string | null;
  denialReason?: string | null;
  byteSize?: number | null;
  contentType?: string | null;
}) {
  return {
    outcome: input.outcome,
    ...(input.workspaceKind ? { workspaceKind: input.workspaceKind } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.projectName ? { projectName: input.projectName } : {}),
    ...(input.displayPath ? { displayPath: input.displayPath } : {}),
    ...(input.denialReason ? { denialReason: input.denialReason } : {}),
    ...(typeof input.byteSize === "number" ? { byteSize: input.byteSize } : {}),
    ...(input.contentType ? { contentType: input.contentType } : {}),
  };
}

function listActivityDetails(input: {
  outcome: "success" | "denied" | "unavailable";
  workspaceSelector: "auto" | "execution" | "project";
  mode: "all" | "recent" | "changed";
  workspaceKind?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  resultCount?: number | null;
  scannedCount?: number | null;
  truncated?: boolean | null;
  denialReason?: string | null;
}) {
  return {
    outcome: input.outcome,
    workspaceSelector: input.workspaceSelector,
    mode: input.mode,
    ...(input.workspaceKind ? { workspaceKind: input.workspaceKind } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.projectName ? { projectName: input.projectName } : {}),
    ...(typeof input.resultCount === "number" ? { resultCount: input.resultCount } : {}),
    ...(typeof input.scannedCount === "number" ? { scannedCount: input.scannedCount } : {}),
    ...(typeof input.truncated === "boolean" ? { truncated: input.truncated } : {}),
    ...(input.denialReason ? { denialReason: input.denialReason } : {}),
  };
}

function safeListAuditQuery(query: unknown): {
  workspace: "auto" | "execution" | "project";
  mode: "all" | "recent" | "changed";
} {
  if (!query || typeof query !== "object") return { workspace: "auto", mode: "all" };
  const record = query as Record<string, unknown>;
  const workspace = typeof record.workspace === "string" && ["auto", "execution", "project"].includes(record.workspace)
    ? (record.workspace as "auto" | "execution" | "project")
    : "auto";
  const mode = typeof record.mode === "string" && ["all", "recent", "changed"].includes(record.mode)
    ? (record.mode as "all" | "recent" | "changed")
    : "all";
  return { workspace, mode };
}

function safeAuditTarget(query: unknown): { projectId: string | null; workspaceId: string | null } {
  if (!query || typeof query !== "object") return { projectId: null, workspaceId: null };
  const record = query as Record<string, unknown>;
  return {
    projectId: typeof record.projectId === "string" ? record.projectId : null,
    workspaceId: typeof record.workspaceId === "string" ? record.workspaceId : null,
  };
}

function safeAuditDisplayPath(query: unknown): string {
  if (!query || typeof query !== "object") return "";
  const path = (query as Record<string, unknown>).path;
  if (typeof path !== "string") return "";
  if (/[\x00-\x1f\x7f]/.test(path)) return "";
  return path;
}

function denialReasonFromError(error: unknown) {
  if (!(error instanceof HttpError)) return "unknown";
  const details = error.details;
  if (details && typeof details === "object" && "code" in details) {
    const code = (details as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return error.message;
}

export function fileResourceRoutes(db: Db, opts: {
  service?: WorkspaceFileResourceService;
  limiter?: FileResourceLimiter;
  listLimiter?: FileResourceLimiter;
} = {}) {
  const router = Router();
  const svc = opts.service ?? workspaceFileResourceService(db);
  const limiter = opts.limiter ?? createFileResourceLimiter();
  const listLimiter = opts.listLimiter ?? createFileResourceListLimiter();

  async function logDeniedAttempt(input: {
    companyId: string;
    actor: ReturnType<typeof getActorInfo>;
    issueId: string;
    displayPath: string;
    projectId?: string | null;
    workspaceId?: string | null;
    error: unknown;
    action?: "issue.file_resource_content_denied" | "issue.file_resource_resolve_denied";
  }) {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      action: input.action ?? "issue.file_resource_content_denied",
      entityType: "issue",
      entityId: input.issueId,
      agentId: input.actor.agentId,
      runId: input.actor.runId,
      details: activityDetails({
        outcome: "denied",
        displayPath: input.displayPath,
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        denialReason: denialReasonFromError(input.error),
      }),
    });
  }

  async function logListDeniedAttempt(input: {
    companyId: string;
    actor: ReturnType<typeof getActorInfo>;
    issueId: string;
    query: { workspace: "auto" | "execution" | "project"; mode: "all" | "recent" | "changed" };
    target?: { projectId: string | null; workspaceId: string | null };
    error: unknown;
  }) {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      action: "issue.file_resource_list_denied",
      entityType: "issue",
      entityId: input.issueId,
      agentId: input.actor.agentId,
      runId: input.actor.runId,
      details: listActivityDetails({
        outcome: "denied",
        workspaceSelector: input.query.workspace,
        mode: input.query.mode,
        projectId: input.target?.projectId ?? null,
        workspaceId: input.target?.workspaceId ?? null,
        denialReason: denialReasonFromError(input.error),
      }),
    });
  }

  router.get("/issues/:issueId/file-resources/list", async (req, res) => {
    const auditQuery = safeListAuditQuery(req.query);
    const auditTarget = safeAuditTarget(req.query);
    try {
      assertBoard(req);
    } catch (error) {
      if (req.actor.type === "agent" && req.actor.companyId) {
        await logListDeniedAttempt({
          companyId: req.actor.companyId,
          actor: getActorInfo(req),
          issueId: req.params.issueId,
          query: auditQuery,
          target: auditTarget,
          error,
        });
      }
      throw error;
    }
    const issue = await svc.getIssue(req.params.issueId);
    const actor = getActorInfo(req);
    try {
      assertCompanyAccess(req, issue.companyId);
    } catch (error) {
      await logListDeniedAttempt({
        companyId: issue.companyId,
        actor,
        issueId: req.params.issueId,
        query: auditQuery,
        target: auditTarget,
        error,
      });
      throw error;
    }

    let query: ReturnType<typeof readListQuery>;
    try {
      query = readListQuery(req.query);
    } catch (error) {
      await logListDeniedAttempt({
        companyId: issue.companyId,
        actor,
        issueId: req.params.issueId,
        query: auditQuery,
        target: auditTarget,
        error,
      });
      throw error;
    }

    let release: (() => void) | null = null;
    try {
      release = listLimiter.acquire(limiterKey(issue.companyId, actor.actorId, req.params.issueId));
    } catch (error) {
      await logListDeniedAttempt({
        companyId: issue.companyId,
        actor,
        issueId: req.params.issueId,
        query,
        target: { projectId: query.projectId, workspaceId: query.workspaceId },
        error,
      });
      throw error;
    }

    try {
      const result = await svc.list(req.params.issueId, query, { issue });
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "issue.file_resource_list",
        entityType: "issue",
        entityId: req.params.issueId,
        agentId: actor.agentId,
        runId: actor.runId,
        details: listActivityDetails({
          outcome: result.state === "available" ? "success" : "unavailable",
          workspaceSelector: result.query.workspace,
          mode: result.query.mode,
          workspaceKind: result.workspace?.workspaceKind ?? null,
          workspaceId: result.workspace?.workspaceId ?? null,
          projectId: result.workspace?.projectId ?? null,
          projectName: result.workspace?.projectName ?? null,
          resultCount: result.items.length,
          scannedCount: result.scannedCount,
          truncated: result.truncated,
          denialReason: result.unavailableReason ?? null,
        }),
      });
      res.json(result);
    } catch (error) {
      await logListDeniedAttempt({
        companyId: issue.companyId,
        actor,
        issueId: req.params.issueId,
        query,
        target: { projectId: query.projectId, workspaceId: query.workspaceId },
        error,
      });
      throw error;
    } finally {
      release?.();
    }
  });

  router.get("/issues/:issueId/file-resources/resolve", async (req, res) => {
    const auditTarget = safeAuditTarget(req.query);
    try {
      assertBoard(req);
    } catch (error) {
      if (req.actor.type === "agent" && req.actor.companyId) {
        await logDeniedAttempt({
          companyId: req.actor.companyId,
          actor: getActorInfo(req),
          issueId: req.params.issueId,
          displayPath: safeAuditDisplayPath(req.query),
          projectId: auditTarget.projectId,
          workspaceId: auditTarget.workspaceId,
          error,
          action: "issue.file_resource_resolve_denied",
        });
      }
      throw error;
    }
    const issue = await svc.getIssue(req.params.issueId);
    const actor = getActorInfo(req);
    try {
      assertCompanyAccess(req, issue.companyId);
    } catch (error) {
      await logDeniedAttempt({
        companyId: issue.companyId,
        actor,
        issueId: req.params.issueId,
        displayPath: safeAuditDisplayPath(req.query),
        projectId: auditTarget.projectId,
        workspaceId: auditTarget.workspaceId,
        error,
        action: "issue.file_resource_resolve_denied",
      });
      throw error;
    }
    let query: ReturnType<typeof readQuery>;
    try {
      query = readQuery(req.query);
    } catch (error) {
      await logDeniedAttempt({
        companyId: issue.companyId,
        actor,
        issueId: req.params.issueId,
        displayPath: safeAuditDisplayPath(req.query),
        projectId: auditTarget.projectId,
        workspaceId: auditTarget.workspaceId,
        error,
        action: "issue.file_resource_resolve_denied",
      });
      throw error;
    }
    let release: (() => void) | null = null;
    try {
      release = limiter.acquire(limiterKey(issue.companyId, actor.actorId, req.params.issueId));
    } catch (error) {
      await logDeniedAttempt({
        companyId: issue.companyId,
        actor,
        issueId: req.params.issueId,
        displayPath: query.path,
        projectId: query.projectId,
        workspaceId: query.workspaceId,
        error,
        action: "issue.file_resource_resolve_denied",
      });
      throw error;
    }
    try {
      const result = await svc.resolve(req.params.issueId, query, { issue });
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "issue.file_resource_resolve",
        entityType: "issue",
        entityId: req.params.issueId,
        agentId: actor.agentId,
        runId: actor.runId,
        details: activityDetails({
          outcome: "success",
          workspaceKind: result.workspaceKind,
          workspaceId: result.workspaceId,
          projectId: result.projectId ?? null,
          projectName: result.projectName ?? null,
          displayPath: result.displayPath,
          byteSize: result.byteSize ?? null,
          contentType: result.contentType ?? null,
          denialReason: result.denialReason ?? null,
        }),
      });
      res.json(result);
    } catch (error) {
      await logDeniedAttempt({
        companyId: issue.companyId,
        actor,
        issueId: req.params.issueId,
        displayPath: query.path,
        projectId: query.projectId,
        workspaceId: query.workspaceId,
        error,
        action: "issue.file_resource_resolve_denied",
      });
      throw error;
    } finally {
      release?.();
    }
  });

  router.get("/issues/:issueId/file-resources/content", async (req, res) => {
    const auditTarget = safeAuditTarget(req.query);
    try {
      assertBoard(req);
    } catch (error) {
      if (req.actor.type === "agent" && req.actor.companyId) {
        await logDeniedAttempt({
          companyId: req.actor.companyId,
          actor: getActorInfo(req),
          issueId: req.params.issueId,
          displayPath: safeAuditDisplayPath(req.query),
          projectId: auditTarget.projectId,
          workspaceId: auditTarget.workspaceId,
          error,
        });
      }
      throw error;
    }
    const issue = await svc.getIssue(req.params.issueId);
    const actor = getActorInfo(req);
    try {
      assertCompanyAccess(req, issue.companyId);
    } catch (error) {
      await logDeniedAttempt({
        companyId: issue.companyId,
        actor,
        issueId: req.params.issueId,
        displayPath: safeAuditDisplayPath(req.query),
        projectId: auditTarget.projectId,
        workspaceId: auditTarget.workspaceId,
        error,
      });
      throw error;
    }
    let query: ReturnType<typeof readQuery>;
    try {
      query = readQuery(req.query);
    } catch (error) {
      await logDeniedAttempt({
        companyId: issue.companyId,
        actor,
        issueId: req.params.issueId,
        displayPath: safeAuditDisplayPath(req.query),
        projectId: auditTarget.projectId,
        workspaceId: auditTarget.workspaceId,
        error,
      });
      throw error;
    }
    let release: (() => void) | null = null;
    try {
      release = limiter.acquire(limiterKey(issue.companyId, actor.actorId, req.params.issueId));
    } catch (error) {
      await logDeniedAttempt({
        companyId: issue.companyId,
        actor,
        issueId: req.params.issueId,
        displayPath: query.path,
        projectId: query.projectId,
        workspaceId: query.workspaceId,
        error,
      });
      throw error;
    }
    try {
      let result: WorkspaceFileContent | null = null;
      try {
        result = await svc.readContent(req.params.issueId, query, { issue });
      } catch (error) {
        await logDeniedAttempt({
          companyId: issue.companyId,
          actor,
          issueId: req.params.issueId,
          displayPath: query.path,
          projectId: query.projectId,
          workspaceId: query.workspaceId,
          error,
        });
        throw error;
      }

      if (!result) throw unprocessable("Workspace file cannot be previewed");
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "issue.file_resource_content_read",
        entityType: "issue",
        entityId: req.params.issueId,
        agentId: actor.agentId,
        runId: actor.runId,
        details: activityDetails({
          outcome: "success",
          workspaceKind: result.resource.workspaceKind,
          workspaceId: result.resource.workspaceId,
          projectId: result.resource.projectId ?? null,
          projectName: result.resource.projectName ?? null,
          displayPath: result.resource.displayPath,
          byteSize: result.resource.byteSize ?? null,
          contentType: result.resource.contentType ?? null,
        }),
      });

      res.set("X-Content-Type-Options", "nosniff");
      res.json(result);
    } finally {
      release?.();
    }
  });

  return router;
}
