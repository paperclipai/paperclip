import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  assignRt2ParticipantSchema,
  cancelRt2ExecutionSchema,
  claimRt2ExecutionSchema,
  cleanupRt2ExecutionsSchema,
  createOneLinerInboundDraftSchema,
  createRt2MessagingInboundSchema,
  completeRt2ExecutionSchema,
  createRt2BoardAttachmentSchema,
  createRt2BoardChecklistItemSchema,
  createRt2TaskSchema,
  createRt2TodoSchema,
  endRt2ParticipantSchema,
  enqueueRt2ExecutionSchema,
  failRt2ExecutionSchema,
  failRt2CaptureDraftSchema,
  dispatchNextRt2ExecutionSchema,
  dispatchRt2ExecutionSchema,
  promoteRt2CaptureDraftSchema,
  reviseRt2CaptureDraftSchema,
  rt2CaptureQueueQuerySchema,
  reorderRt2BoardChecklistSchema,
  startRt2ExecutionSchema,
  transitionRt2CaptureDraftSchema,
  updateRt2BoardCardSchema,
  updateRt2BoardChecklistItemSchema,
  updateRt2TaskCapacitySchema,
  upsertRt2CaptureSourceSchema,
  rt2MessagingInboundSourceSchema,
  buildOneLinerRewardEvidence,
} from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { issueService } from "../services/issues.js";
import { rt2TaskExecutionService } from "../services/rt2-task-execution.js";
import { rt2TaskEngineService } from "../services/rt2-task-engine.js";
import { rt2WorkBoardService } from "../services/rt2-work-board.js";
import { assertCompanyAccess } from "./authz.js";
import { logActivity } from "../services/activity-log.js";

function assertBoardActor(req: Request): string {
  if (req.actor.type !== "board" || !req.actor.userId) {
    throw forbidden("Board user required");
  }
  return req.actor.userId;
}

function cleanString(value: unknown, max = 500) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).slice(0, max);
  }
  return null;
}

function readPath(payload: Record<string, unknown>, path: string[]) {
  let current: unknown = payload;
  for (const part of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function firstString(payload: Record<string, unknown>, paths: string[][], max = 500) {
  for (const path of paths) {
    const value = cleanString(path.length === 1 ? payload[path[0]!] : readPath(payload, path), max);
    if (value) return value;
  }
  return null;
}

function normalizeTimestamp(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function metadataFromPayload(source: "slack" | "teams" | "webhook", payload: Record<string, unknown>, parsedMetadata?: Record<string, string>) {
  const metadata: Record<string, string> = {
    ...(parsedMetadata ?? {}),
    provider: source,
  };
  const candidates: Array<[string, string[][]]> = [
    ["channel", [["channel"], ["channelId"], ["channel_id"], ["event", "channel"], ["message", "channel"]]],
    ["externalUserId", [["externalUserId"], ["userId"], ["user_id"], ["event", "user"], ["message", "user"]]],
    ["eventId", [["eventId"], ["event_id"], ["messageId"], ["message_id"], ["event", "client_msg_id"], ["event", "ts"]]],
    ["teamId", [["teamId"], ["team_id"], ["team", "id"], ["event", "team"]]],
    ["tenantId", [["tenantId"], ["tenant_id"]]],
    ["threadId", [["threadId"], ["thread_ts"], ["event", "thread_ts"]]],
    ["permalink", [["permalink"], ["message", "permalink"]]],
  ];
  for (const [key, paths] of candidates) {
    const value = firstString(payload, paths);
    if (value) metadata[key] = value;
  }
  return Object.fromEntries(Object.entries(metadata).slice(0, 20));
}

function inboundResponse(storedDraft: {
  id: string;
  source: string;
  channel: string | null;
  externalUserId: string | null;
  status: string;
  duplicateOfDraftId: string | null;
  permissionStatus: string;
  sourceEvidence: unknown;
  semanticContext: unknown;
  duplicateWarning: string | null;
  parsedDraft: Record<string, unknown>;
}) {
  return {
    draft: storedDraft.parsedDraft,
    inbound: {
      id: storedDraft.id,
      source: storedDraft.source,
      channel: storedDraft.channel,
      externalUserId: storedDraft.externalUserId,
      status: storedDraft.status,
      duplicateOfDraftId: storedDraft.duplicateOfDraftId,
      permissionStatus: storedDraft.permissionStatus,
      sourceEvidence: storedDraft.sourceEvidence,
      semanticContext: storedDraft.semanticContext,
      duplicateWarning: storedDraft.duplicateWarning,
      reviewRequired: storedDraft.status === "review_required",
    },
  };
}

export function rt2TaskRoutes(db: Db) {
  const router = Router();
  const svc = rt2TaskEngineService(db);
  const executionSvc = rt2TaskExecutionService(db);
  const issuesSvc = issueService(db);
  const boardSvc = rt2WorkBoardService(db);

  router.get("/companies/:companyId/rt2/tasks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const projectId = String(req.query.projectId ?? "").trim();
    if (!projectId) {
      throw badRequest("projectId is required");
    }

    const tasks = await svc.listByProject(companyId, projectId);
    res.json(tasks);
  });

  router.post("/companies/:companyId/rt2/tasks", validate(createRt2TaskSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actorUserId = assertBoardActor(req);

    const issue = await svc.createTask(companyId, actorUserId, req.body);
    const basePrice = req.body.deliverables.reduce(
      (total: number, deliverable: { basePrice: number }) => total + deliverable.basePrice,
      0,
    );

    res.status(201).json({
      issueId: issue.id,
      deliverables: req.body.deliverables.map((deliverable: { title: string; type: "document" | "artifact"; basePrice: number }) => ({
        title: deliverable.title,
        type: deliverable.type,
        basePrice: deliverable.basePrice,
      })),
      rewardEvidence: buildOneLinerRewardEvidence({
        basePrice,
        deliverableCount: req.body.deliverables.length,
        source: "web",
      }),
    });
  });

  router.post(
    "/companies/:companyId/rt2/one-liner/inbound-draft",
    validate(createOneLinerInboundDraftSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actorUserId = assertBoardActor(req);

      const storedDraft = await boardSvc.createInboundDraft(companyId, actorUserId, req.body);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId,
        action: "rt2.capture.inbound_draft_created",
        entityType: "capture_draft",
        entityId: storedDraft.id,
        details: {
          source: storedDraft.source,
          status: storedDraft.status,
          duplicateOfDraftId: storedDraft.duplicateOfDraftId,
          permissionStatus: storedDraft.permissionStatus,
        },
      });
      res.status(201).json(inboundResponse(storedDraft));
    },
  );

  router.post("/companies/:companyId/rt2/capture-sources/:source/inbound", async (req, res) => {
    const companyId = req.params.companyId as string;
    const sourceResult = rt2MessagingInboundSourceSchema.safeParse(req.params.source);
    if (!sourceResult.success) {
      throw badRequest("Messaging capture source must be slack, teams, or webhook");
    }
    const source = sourceResult.data;
    const sourceRecord = await boardSvc.getCaptureSource(companyId, source);
    if (!sourceRecord?.id) {
      res.status(404).json({ error: "RT2_CAPTURE_SOURCE_NOT_INSTALLED" });
      return;
    }

    const payload = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    const parsed = createRt2MessagingInboundSchema.safeParse(payload);
    const data: Record<string, unknown> = parsed.success ? parsed.data : payload;
    const signature = req.header("x-rt2-signature") ?? cleanString(data.signature) ?? null;
    const text = firstString(data, [["text"], ["messageText"], ["message", "text"], ["event", "text"]], 5000);
    const channel = firstString(data, [["channel"], ["channelId"], ["channel_id"], ["event", "channel"], ["message", "channel"]], 120);
    const externalUserId = firstString(data, [["externalUserId"], ["userId"], ["user_id"], ["event", "user"], ["message", "user"]], 200);
    const eventId = firstString(data, [["eventId"], ["event_id"], ["messageId"], ["message_id"], ["event", "client_msg_id"], ["event", "ts"]], 200);
    const eventTimestamp = normalizeTimestamp(firstString(data, [["eventTimestamp"], ["timestamp"], ["event", "event_ts"], ["event", "ts"]], 120));
    const parsedMetadata = parsed.success ? parsed.data.metadata : undefined;
    const metadata = metadataFromPayload(source, data, parsedMetadata);
    const actorUserId = "messaging-inbound";

    const storedDraft = text
      ? await boardSvc.createInboundDraft(companyId, actorUserId, {
        source,
        text,
        channel,
        externalUserId,
        sourceInstallationId: sourceRecord.id,
        eventId,
        eventTimestamp,
        signature,
        metadata,
      })
      : await boardSvc.createMalformedInboundDraft(companyId, actorUserId, {
        source,
        channel,
        externalUserId,
        sourceInstallationId: sourceRecord.id,
        eventId,
        eventTimestamp,
        signature,
        metadata,
        failureMessage: parsed.success
          ? "Messaging payload did not include capture text."
          : "Messaging payload did not match the expected capture shape.",
      });

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: actorUserId,
      action: "rt2.capture.messaging_inbound_received",
      entityType: "capture_draft",
      entityId: storedDraft.id,
      details: {
        source: storedDraft.source,
        status: storedDraft.status,
        duplicateOfDraftId: storedDraft.duplicateOfDraftId,
        permissionStatus: storedDraft.permissionStatus,
        sourceEvidence: storedDraft.sourceEvidence,
      },
    });
    res.status(201).json(inboundResponse(storedDraft));
  });

  router.get("/companies/:companyId/rt2/capture-sources", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardActor(req);
    res.json(await boardSvc.listCaptureSources(companyId));
  });

  router.put("/companies/:companyId/rt2/capture-sources/:source", validate(upsertRt2CaptureSourceSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actorUserId = assertBoardActor(req);
    const source = req.params.source as string;
    if (source !== req.body.source) {
      throw badRequest("source path and body must match");
    }
    const record = await boardSvc.upsertCaptureSource(companyId, actorUserId, req.body);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId,
      action: "rt2.capture.source_configured",
      entityType: "capture_source",
      entityId: record.id ?? source,
      details: {
        source: record.source,
        installationState: record.installationState,
        signingStatus: record.signingStatus,
        blockedReason: record.blockedReason,
      },
    });
    res.json(record);
  });

  router.get("/companies/:companyId/rt2/work-board", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const issueIds = String(req.query.issueIds ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    res.json(await boardSvc.getBoardOverview(companyId, issueIds));
  });

  router.patch("/companies/:companyId/rt2/work-board/cards/:issueId", validate(updateRt2BoardCardSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actorUserId = assertBoardActor(req);
    const card = await boardSvc.updateCard(companyId, req.params.issueId as string, actorUserId, req.body);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId,
      action: "rt2.work_board.card_updated",
      entityType: "issue",
      entityId: req.params.issueId as string,
      details: req.body,
    });
    res.json(card);
  });

  router.post("/companies/:companyId/rt2/work-board/cards/:issueId/checklist", validate(createRt2BoardChecklistItemSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actorUserId = assertBoardActor(req);
    const item = await boardSvc.addChecklistItem(companyId, req.params.issueId as string, actorUserId, req.body);
    res.status(201).json(item);
  });

  router.patch("/companies/:companyId/rt2/work-board/cards/:issueId/checklist/:itemId", validate(updateRt2BoardChecklistItemSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardActor(req);
    res.json(await boardSvc.updateChecklistItem(companyId, req.params.issueId as string, req.params.itemId as string, req.body));
  });

  router.post("/companies/:companyId/rt2/work-board/cards/:issueId/checklist/reorder", validate(reorderRt2BoardChecklistSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardActor(req);
    res.json(await boardSvc.reorderChecklist(companyId, req.params.issueId as string, req.body.orderedItemIds));
  });

  router.post("/companies/:companyId/rt2/work-board/cards/:issueId/attachments", validate(createRt2BoardAttachmentSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actorUserId = assertBoardActor(req);
res.status(201).json(await boardSvc.addAttachment(companyId, req.params.issueId as string, actorUserId, req.body));
  });

  // Custom field routes
  router.get("/companies/:companyId/rt2/work-board/custom-fields", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await boardSvc.getCustomFieldDefinitions(companyId));
  });

  router.post("/companies/:companyId/rt2/work-board/custom-fields", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actorUserId = assertBoardActor(req);
    const { name, fieldType } = req.body;
    res.status(201).json(await boardSvc.createCustomField(companyId, actorUserId, { name, fieldType }));
  });

  router.patch("/rt2/custom-fields/:fieldId", async (req, res) => {
    const actorUserId = assertBoardActor(req);
    const { fieldId } = req.params;
    const companyId = String(req.query.companyId ?? "");
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);
    res.json(await boardSvc.updateCustomField(companyId, fieldId, req.body));
  });

  router.delete("/rt2/custom-fields/:fieldId", async (req, res) => {
    const actorUserId = assertBoardActor(req);
    const { fieldId } = req.params;
    const companyId = String(req.query.companyId ?? "");
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);
    await boardSvc.deleteCustomField(companyId, fieldId);
    res.status(204).send();
  });

  router.get("/rt2/custom-fields/:fieldId/options", async (req, res) => {
    const { fieldId } = req.params;
    const companyId = String(req.query.companyId ?? "");
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);
    res.json(await boardSvc.getCustomFieldOptions(companyId, fieldId));
  });

  router.post("/rt2/custom-fields/:fieldId/options", async (req, res) => {
    const actorUserId = assertBoardActor(req);
    const { fieldId } = req.params;
    const companyId = String(req.query.companyId ?? "");
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);
    res.status(201).json(await boardSvc.createCustomFieldOption(companyId, fieldId, req.body));
  });

  router.delete("/rt2/custom-field-options/:optionId", async (req, res) => {
    const actorUserId = assertBoardActor(req);
    const { optionId } = req.params;
    const companyId = String(req.query.companyId ?? "");
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);
    await boardSvc.deleteCustomFieldOption(companyId, optionId);
    res.status(204).send();
  });

  router.get("/companies/:companyId/rt2/work-board/cards/:issueId/custom-field-values", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { issueId } = req.params;
    const result = await boardSvc.getCardCustomFieldValues(companyId, [issueId]);
    res.json(result.get(issueId) ?? []);
  });

  router.patch("/companies/:companyId/rt2/work-board/cards/:issueId/custom-field-values/:fieldId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actorUserId = assertBoardActor(req);
    const { issueId, fieldId } = req.params;
    res.json(await boardSvc.upsertCardCustomFieldValue(companyId, issueId, actorUserId, { fieldId, ...req.body }));
  });

  router.get("/companies/:companyId/rt2/capture-drafts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardActor(req);
    res.json(await boardSvc.listCaptureQueue(companyId, rt2CaptureQueueQuerySchema.parse(req.query)));
  });

  router.get("/companies/:companyId/rt2/capture-drafts/reliability-report", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardActor(req);
    res.json(await boardSvc.getCaptureReliabilityReport(companyId));
  });

  router.get("/companies/:companyId/rt2/capture-drafts/:draftId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardActor(req);
    res.json(await boardSvc.getCaptureDraftDetail(companyId, req.params.draftId as string));
  });

  router.post("/companies/:companyId/rt2/capture-drafts/:draftId/revisions", validate(reviseRt2CaptureDraftSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actorUserId = assertBoardActor(req);
    const draft = await boardSvc.reviseCaptureDraft(companyId, req.params.draftId as string, actorUserId, req.body);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId,
      action: "rt2.capture.draft_revised",
      entityType: "capture_draft",
      entityId: draft.id,
      details: {
        revisionId: draft.latestRevision?.id ?? null,
        revisionNumber: draft.latestRevision?.revisionNumber ?? null,
        changeSummary: draft.latestRevision?.changeSummary ?? null,
      },
    });
    res.status(201).json(draft);
  });

  router.post("/companies/:companyId/rt2/capture-drafts/:draftId/transition", validate(transitionRt2CaptureDraftSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actorUserId = assertBoardActor(req);
    const draft = await boardSvc.transitionCaptureDraft(companyId, req.params.draftId as string, actorUserId, req.body);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId,
      action: "rt2.capture.draft_transitioned",
      entityType: "capture_draft",
      entityId: draft.id,
      details: {
        action: req.body.action,
        reason: req.body.reason ?? null,
        status: draft.status,
        revisionId: draft.latestRevision?.id ?? null,
        revisionNumber: draft.latestRevision?.revisionNumber ?? null,
      },
    });
    res.json(draft);
  });

  router.post("/companies/:companyId/rt2/capture-drafts/:draftId/promote", validate(promoteRt2CaptureDraftSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actorUserId = assertBoardActor(req);
    const draft = await boardSvc.promoteCaptureDraft(companyId, req.params.draftId as string, actorUserId, req.body);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId,
      action: "rt2.capture.draft_promoted",
      entityType: "capture_draft",
      entityId: draft.id,
      details: {
        target: draft.promotionTarget,
        promotedIssueId: draft.promotedIssueId,
        promotedWorkProductId: draft.promotedWorkProductId,
        revisionId: draft.latestRevision?.id ?? null,
        revisionNumber: draft.latestRevision?.revisionNumber ?? null,
      },
    });
    res.json(draft);
  });

  router.post("/companies/:companyId/rt2/capture-drafts/:draftId/fail", validate(failRt2CaptureDraftSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actorUserId = assertBoardActor(req);
    const draft = await boardSvc.failCaptureDraft(companyId, req.params.draftId as string, actorUserId, req.body);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId,
      action: "rt2.capture.draft_failed",
      entityType: "capture_draft",
      entityId: draft.id,
      details: { failureCode: draft.failureCode, failureMessage: draft.failureMessage, status: draft.status },
    });
    res.json(draft);
  });

  router.get("/rt2/tasks/:taskIssueId", async (req, res) => {
    const task = await svc.getTaskMeta(req.params.taskIssueId as string);
    assertCompanyAccess(req, task.companyId);

    const detail = await svc.getDetail(task.issueId);
    res.json(detail);
  });

  router.get("/rt2/tasks/:taskIssueId/assignable-users", async (req, res) => {
    const task = await svc.getTaskMeta(req.params.taskIssueId as string);
    assertCompanyAccess(req, task.companyId);

    const users = await svc.listAssignableUsers(task.issueId);
    res.json(users);
  });

  router.post("/rt2/tasks/:taskIssueId/join", async (req, res) => {
    const actorUserId = assertBoardActor(req);
    const task = await svc.getTaskMeta(req.params.taskIssueId as string);
    assertCompanyAccess(req, task.companyId);

    const participant = await svc.joinTask(task.issueId, actorUserId);

    res.status(201).json(participant);
  });

  router.post("/rt2/tasks/:taskIssueId/participants", validate(assignRt2ParticipantSchema), async (req, res) => {
    const actorUserId = assertBoardActor(req);
    const task = await svc.getTaskMeta(req.params.taskIssueId as string);
    assertCompanyAccess(req, task.companyId);

    const participant = await svc.assignParticipant(task.issueId, actorUserId, req.body);

    res.status(201).json(participant);
  });

  router.patch("/rt2/tasks/:taskIssueId/capacity", validate(updateRt2TaskCapacitySchema), async (req, res) => {
    const actorUserId = assertBoardActor(req);
    const task = await svc.getTaskMeta(req.params.taskIssueId as string);
    assertCompanyAccess(req, task.companyId);

    const updated = await svc.updateCapacity(task.issueId, actorUserId, req.body);

    res.json(updated);
  });

  router.post(
    "/rt2/tasks/:taskIssueId/participants/:userId/end",
    validate(endRt2ParticipantSchema),
    async (req, res) => {
      const actorUserId = assertBoardActor(req);
      const task = await svc.getTaskMeta(req.params.taskIssueId as string);
      assertCompanyAccess(req, task.companyId);

      const ended = await svc.endParticipant(task.issueId, actorUserId, req.params.userId as string, req.body);

      res.json(ended);
    },
  );

  router.post("/rt2/tasks/:taskIssueId/todos", validate(createRt2TodoSchema), async (req, res) => {
    const actorUserId = assertBoardActor(req);
    const task = await svc.getTaskMeta(req.params.taskIssueId as string);
    assertCompanyAccess(req, task.companyId);

    const todo = await svc.createTodo(task.issueId, actorUserId, req.body);

    res.status(201).json(todo);
  });

  router.post("/rt2/tasks/:taskIssueId/executions", validate(enqueueRt2ExecutionSchema), async (req, res) => {
    const actorUserId = assertBoardActor(req);
    const task = await svc.getTaskMeta(req.params.taskIssueId as string);
    assertCompanyAccess(req, task.companyId);

    const attempt = await executionSvc.enqueue(task.issueId, actorUserId, req.body);

    res.status(201).json(attempt);
  });

  router.post(
    "/companies/:companyId/rt2/executions/dispatch-next",
    validate(dispatchNextRt2ExecutionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoardActor(req);

      const attempt = await executionSvc.dispatchNext(companyId, req.body);

      res.json(attempt);
    },
  );

  router.post(
    "/companies/:companyId/rt2/executions/cleanup-stale",
    validate(cleanupRt2ExecutionsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoardActor(req);

      const result = await executionSvc.cleanupStale(companyId, req.body);

      res.json(result);
    },
  );

  router.post("/rt2/executions/:attemptId/dispatch", validate(dispatchRt2ExecutionSchema), async (req, res) => {
    assertBoardActor(req);
    const attemptBefore = await executionSvc.getAttempt(req.params.attemptId as string);
    assertCompanyAccess(req, attemptBefore.companyId);

    const attempt = await executionSvc.dispatch(attemptBefore.id, req.body);

    res.json(attempt);
  });

  router.post("/rt2/executions/:attemptId/claim", validate(claimRt2ExecutionSchema), async (req, res) => {
    assertBoardActor(req);
    const attemptBefore = await executionSvc.getAttempt(req.params.attemptId as string);
    assertCompanyAccess(req, attemptBefore.companyId);

    const attempt = await executionSvc.claim(attemptBefore.id, req.body);

    res.json(attempt);
  });

  router.post("/rt2/executions/:attemptId/start", validate(startRt2ExecutionSchema), async (req, res) => {
    assertBoardActor(req);
    const attemptBefore = await executionSvc.getAttempt(req.params.attemptId as string);
    assertCompanyAccess(req, attemptBefore.companyId);

    const attempt = await executionSvc.start(attemptBefore.id, req.body);

    res.json(attempt);
  });

  router.post("/rt2/executions/:attemptId/complete", validate(completeRt2ExecutionSchema), async (req, res) => {
    assertBoardActor(req);
    const attemptBefore = await executionSvc.getAttempt(req.params.attemptId as string);
    assertCompanyAccess(req, attemptBefore.companyId);

    const attempt = await executionSvc.complete(attemptBefore.id, req.body);

    res.json(attempt);
  });

  router.post("/rt2/executions/:attemptId/fail", validate(failRt2ExecutionSchema), async (req, res) => {
    assertBoardActor(req);
    const attemptBefore = await executionSvc.getAttempt(req.params.attemptId as string);
    assertCompanyAccess(req, attemptBefore.companyId);

    const attempt = await executionSvc.fail(attemptBefore.id, req.body);

    res.json(attempt);
  });

  router.post("/rt2/executions/:attemptId/cancel", validate(cancelRt2ExecutionSchema), async (req, res) => {
    assertBoardActor(req);
    const attemptBefore = await executionSvc.getAttempt(req.params.attemptId as string);
    assertCompanyAccess(req, attemptBefore.companyId);

    const attempt = await executionSvc.cancel(attemptBefore.id, req.body);

    res.json(attempt);
  });

  router.get("/rt2/executions/:attemptId/timeline", async (req, res) => {
    assertBoardActor(req);
    const attemptBefore = await executionSvc.getAttempt(req.params.attemptId as string);
    assertCompanyAccess(req, attemptBefore.companyId);

    const timeline = await executionSvc.listTimeline(attemptBefore.id);

    res.json(timeline);
  });

  router.post("/rt2/executions/:attemptId/retry", async (req, res) => {
    const actorUserId = assertBoardActor(req);
    const attemptBefore = await executionSvc.getAttempt(req.params.attemptId as string);
    assertCompanyAccess(req, attemptBefore.companyId);

    const attempt = await executionSvc.retry(attemptBefore.id, actorUserId);

    res.status(201).json(attempt);
  });

  router.post("/rt2/todos/:todoIssueId/start", async (req, res) => {
    assertBoardActor(req);
    const todo = await issuesSvc.getById(req.params.todoIssueId as string);
    if (!todo) {
      res.status(404).json({ error: "RT2 todo not found" });
      return;
    }
    assertCompanyAccess(req, todo.companyId);

    const started = await svc.startTodo(todo.id);

    res.json(started.todo);
  });

  return router;
}
