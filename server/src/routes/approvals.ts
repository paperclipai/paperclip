import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  addApprovalCommentSchema,
  createAgentSchema,
  createApprovalSchema,
  isUuidLike,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  approvalService,
  heartbeatService,
  issueApprovalService,
  logActivity,
  secretService,
} from "../services/index.js";
import { buildIssueWakeContextSnapshot } from "../services/issue-assignment-wakeup.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { redactEventPayload } from "../redaction.js";
import { unprocessable } from "../errors.js";

const PLACEHOLDER_ID_LITERALS = new Set(["none", "null", "undefined"]);
const PAPERCLIP_AGENT_ID_PLACEHOLDER_REGEX = /^\$?\{?PAPERCLIP_AGENT_ID\}?$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergePlainRecords(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainRecord(value) && isPlainRecord(merged[key])) {
      merged[key] = mergePlainRecords(merged[key] as Record<string, unknown>, value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function asMeaningfulString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (PLACEHOLDER_ID_LITERALS.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

function normalizeUuidReference(
  value: unknown,
  fallback: string | null = null,
): string | null {
  const trimmed = asMeaningfulString(value);
  if (!trimmed) return fallback;
  return isUuidLike(trimmed) ? trimmed : null;
}

function normalizeReportsToReference(
  value: unknown,
  requestedByAgentId: string | null,
): string | null {
  const trimmed = asMeaningfulString(value);
  if (!trimmed) return null;
  if (PAPERCLIP_AGENT_ID_PLACEHOLDER_REGEX.test(trimmed)) {
    return normalizeUuidReference(requestedByAgentId);
  }
  return trimmed;
}

function normalizeDesiredSkills(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const skills = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return skills.length > 0 ? skills : [];
}

function redactApprovalPayload<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactEventPayload(approval.payload) ?? {},
  };
}

function buildApprovalWakeMetadata(approval: {
  type: string;
  payload: Record<string, unknown>;
}) {
  const redacted = redactApprovalPayload(approval);
  const payload = isPlainRecord(redacted.payload) ? redacted.payload : {};

  return {
    approvalType: approval.type,
    approvalPayloadName: asMeaningfulString(payload.name),
    approvalPayloadRole: asMeaningfulString(payload.role),
    approvalPayloadAgentId: normalizeUuidReference(payload.agentId),
    approvalPayloadReportsTo: normalizeUuidReference(payload.reportsTo),
    approvalPayloadAdapterType: asMeaningfulString(payload.adapterType),
    approvalPayloadDesiredSkills: normalizeDesiredSkills(payload.desiredSkills),
  };
}

export function approvalRoutes(db: Db) {
  const router = Router();
  const svc = approvalService(db);
  const heartbeat = heartbeatService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const secretsSvc = secretService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  function isInvalidUuidError(error: unknown) {
    return typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { code?: unknown }).code === "22P02";
  }

  async function getApprovalOrNull(id: string) {
    try {
      return await svc.getById(id);
    } catch (error) {
      if (isInvalidUuidError(error)) {
        if (isUuidLike(id)) {
          throw unprocessable("Approval payload contains an invalid identifier");
        }
        return null;
      }
      throw error;
    }
  }

  async function runApprovalMutationOrNull<T>(id: string, operation: () => Promise<T>) {
    try {
      return await operation();
    } catch (error) {
      if (isInvalidUuidError(error)) {
        if (isUuidLike(id)) {
          throw unprocessable("Approval payload contains an invalid identifier");
        }
        return null;
      }
      throw error;
    }
  }

  function buildValidatedHireResubmitPayload(
    existing: {
      payload: Record<string, unknown>;
      requestedByAgentId: string | null;
    },
    patch: Record<string, unknown>,
  ) {
    const existingPayload = isPlainRecord(existing.payload) ? existing.payload : {};
    const merged = mergePlainRecords(existingPayload, patch);
    const fallbackRequestedByAgentId = normalizeUuidReference(existing.requestedByAgentId);
    const requestedConfigurationSnapshot = isPlainRecord(merged.requestedConfigurationSnapshot)
      ? merged.requestedConfigurationSnapshot
      : {};

    const parsed = createAgentSchema.safeParse({
      name: merged.name,
      role: merged.role,
      title: merged.title ?? null,
      icon: merged.icon ?? null,
      reportsTo: normalizeReportsToReference(merged.reportsTo, fallbackRequestedByAgentId),
      capabilities: merged.capabilities ?? null,
      desiredSkills: normalizeDesiredSkills(merged.desiredSkills),
      adapterType: merged.adapterType,
      adapterConfig: isPlainRecord(merged.adapterConfig) ? merged.adapterConfig : {},
      runtimeConfig: isPlainRecord(merged.runtimeConfig) ? merged.runtimeConfig : {},
      budgetMonthlyCents:
        typeof merged.budgetMonthlyCents === "number"
          ? merged.budgetMonthlyCents
          : 0,
      metadata:
        isPlainRecord(merged.metadata) || merged.metadata === null
          ? merged.metadata
          : null,
    });
    if (!parsed.success) {
      throw unprocessable("Invalid hire approval resubmit payload", parsed.error.flatten());
    }

    return {
      ...merged,
      ...parsed.data,
      title: parsed.data.title ?? null,
      icon: parsed.data.icon ?? null,
      reportsTo: parsed.data.reportsTo ?? null,
      capabilities: parsed.data.capabilities ?? null,
      desiredSkills: parsed.data.desiredSkills ?? null,
      adapterConfig: parsed.data.adapterConfig ?? {},
      runtimeConfig: parsed.data.runtimeConfig ?? {},
      budgetMonthlyCents: parsed.data.budgetMonthlyCents,
      metadata: parsed.data.metadata ?? null,
      agentId: normalizeUuidReference(
        merged.agentId,
        normalizeUuidReference(existingPayload.agentId),
      ),
      requestedByAgentId: normalizeUuidReference(
        merged.requestedByAgentId,
        fallbackRequestedByAgentId,
      ),
      requestedConfigurationSnapshot: {
        ...requestedConfigurationSnapshot,
        adapterType: parsed.data.adapterType,
        adapterConfig: parsed.data.adapterConfig ?? {},
        runtimeConfig: parsed.data.runtimeConfig ?? {},
        desiredSkills: parsed.data.desiredSkills ?? null,
      },
    };
  }

  async function queueRequesterApprovalWakeup(input: {
    approval: {
      id: string;
      companyId: string;
      status: string;
      type: string;
      payload: Record<string, unknown>;
      requestedByAgentId: string | null;
      decisionNote?: string | null;
    };
    action:
      | "approval.approved"
      | "approval.rejected"
      | "approval.revision_requested";
    wakeReason:
      | "approval_approved"
      | "approval_rejected"
      | "approval_revision_requested";
    actorUserId: string;
  }) {
    const { approval, action, wakeReason, actorUserId } = input;
    if (!approval.requestedByAgentId) return;

    const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
    const linkedIssueIds = linkedIssues.map((issue) => issue.id);
    const primaryIssue = linkedIssues[0] ?? null;
    const primaryIssueId = primaryIssue?.id ?? null;
    const wakeMetadata = buildApprovalWakeMetadata(approval);
    const baseContextSnapshot = primaryIssue
      ? buildIssueWakeContextSnapshot(primaryIssue, action, { issueIds: linkedIssueIds })
      : {
          source: action,
          issueId: primaryIssueId,
          issueIds: linkedIssueIds,
          taskId: primaryIssueId,
        };

    try {
      const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: wakeReason,
        payload: {
          approvalId: approval.id,
          approvalStatus: approval.status,
          issueId: primaryIssueId,
          issueIds: linkedIssueIds,
          decisionNote: approval.decisionNote ?? null,
          wakeReason,
          ...wakeMetadata,
        },
        requestedByActorType: "user",
        requestedByActorId: actorUserId,
        contextSnapshot: {
          ...baseContextSnapshot,
          approvalId: approval.id,
          approvalStatus: approval.status,
          decisionNote: approval.decisionNote ?? null,
          wakeReason,
          ...wakeMetadata,
        },
      });

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: actorUserId,
        action: "approval.requester_wakeup_queued",
        entityType: "approval",
        entityId: approval.id,
        details: {
          requesterAgentId: approval.requestedByAgentId,
          wakeRunId: wakeRun?.id ?? null,
          wakeReason,
          linkedIssueIds,
        },
      });
    } catch (err) {
      logger.warn(
        {
          err,
          approvalId: approval.id,
          requestedByAgentId: approval.requestedByAgentId,
          wakeReason,
        },
        "failed to queue requester wakeup after approval decision",
      );
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: actorUserId,
        action: "approval.requester_wakeup_failed",
        entityType: "approval",
        entityId: approval.id,
        details: {
          requesterAgentId: approval.requestedByAgentId,
          wakeReason,
          linkedIssueIds,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  router.get("/companies/:companyId/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const status = req.query.status as string | undefined;
    const result = await svc.list(companyId, status);
    res.json(result.map((approval) => redactApprovalPayload(approval)));
  });

  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await getApprovalOrNull(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    res.json(redactApprovalPayload(approval));
  });

  router.post("/companies/:companyId/approvals", validate(createApprovalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rawIssueIds = req.body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const uniqueIssueIds = Array.from(new Set(issueIds));
    const { issueIds: _issueIds, ...approvalInput } = req.body;
    const normalizedPayload =
      approvalInput.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            companyId,
            approvalInput.payload,
            { strictMode: strictSecretsMode },
          )
        : approvalInput.payload;

    const actor = getActorInfo(req);
    const approval = await svc.create(companyId, {
      ...approvalInput,
      payload: normalizedPayload,
      requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
      requestedByAgentId:
        approvalInput.requestedByAgentId ?? (actor.actorType === "agent" ? actor.actorId : null),
      status: "pending",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    if (uniqueIssueIds.length > 0) {
      await issueApprovalsSvc.linkManyForApproval(approval.id, uniqueIssueIds, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.created",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, issueIds: uniqueIssueIds },
    });

    res.status(201).json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/issues", async (req, res) => {
    const id = req.params.id as string;
    const approval = await getApprovalOrNull(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const issues = await issueApprovalsSvc.listIssuesForApproval(id);
    res.json(issues);
  });

  router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const actorUserId = req.actor.userId ?? "board";
    const resolved = await runApprovalMutationOrNull(id, () =>
      svc.approve(
        id,
        req.body.decidedByUserId ?? "board",
        req.body.decisionNote,
      )
    );
    if (!resolved) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const { approval, applied } = resolved;

    if (applied) {
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: actorUserId,
        action: "approval.approved",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          requestedByAgentId: approval.requestedByAgentId,
          linkedIssueIds,
        },
      });

      await queueRequesterApprovalWakeup({
        approval,
        action: "approval.approved",
        wakeReason: "approval_approved",
        actorUserId,
      });
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const actorUserId = req.actor.userId ?? "board";
    const resolved = await runApprovalMutationOrNull(id, () =>
      svc.reject(
        id,
        req.body.decidedByUserId ?? "board",
        req.body.decisionNote,
      )
    );
    if (!resolved) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const { approval, applied } = resolved;

    if (applied) {
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: actorUserId,
        action: "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          requestedByAgentId: approval.requestedByAgentId,
          linkedIssueIds,
        },
      });
      await queueRequesterApprovalWakeup({
        approval,
        action: "approval.rejected",
        wakeReason: "approval_rejected",
        actorUserId,
      });
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const actorUserId = req.actor.userId ?? "board";
      const approval = await runApprovalMutationOrNull(id, () =>
        svc.requestRevision(
          id,
          req.body.decidedByUserId ?? "board",
          req.body.decisionNote,
        )
      );
      if (!approval) {
        res.status(404).json({ error: "Approval not found" });
        return;
      }

      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: actorUserId,
        action: "approval.revision_requested",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          requestedByAgentId: approval.requestedByAgentId,
          linkedIssueIds,
        },
      });
      await queueRequesterApprovalWakeup({
        approval,
        action: "approval.revision_requested",
        wakeReason: "approval_revision_requested",
        actorUserId,
      });

      res.json(redactApprovalPayload(approval));
    },
  );

  router.post("/approvals/:id/resubmit", validate(resubmitApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getApprovalOrNull(id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    if (req.actor.type === "agent" && req.actor.agentId !== existing.requestedByAgentId) {
      res.status(403).json({ error: "Only requesting agent can resubmit this approval" });
      return;
    }

    const normalizedPayload = req.body.payload
      ? existing.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            existing.companyId,
            buildValidatedHireResubmitPayload(existing, req.body.payload),
            { strictMode: strictSecretsMode },
          )
        : req.body.payload
      : undefined;
    const approval = await runApprovalMutationOrNull(id, () => svc.resubmit(id, normalizedPayload));
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });
    res.json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const approval = await getApprovalOrNull(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post("/approvals/:id/comments", validate(addApprovalCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const approval = await getApprovalOrNull(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const actor = getActorInfo(req);
    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id },
    });

    res.status(201).json(comment);
  });

  return router;
}
