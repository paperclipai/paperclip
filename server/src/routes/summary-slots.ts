import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { generateSummarySlotSchema, writeSummarySlotSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { forbidden, notFound } from "../errors.js";
import { accessService, heartbeatService, instanceSettingsService, logActivity } from "../services/index.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { summarySlotService } from "../services/summary-slots.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

function readScopeId(req: Request): string | null {
  const raw = req.query.scopeId;
  if (typeof raw === "string" && raw.trim().length > 0) return raw;
  return null;
}

export function summarySlotSessionTaskKey(input: {
  companyId: string;
  scopeKind: string;
  slotKey: string;
  scopeId: string | null;
}) {
  return `summary-slot:${input.companyId}:${input.scopeKind}:${input.scopeId ?? "company"}:${input.slotKey}`;
}

export function summarySlotRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const settings = instanceSettingsService(db);
  const svc = summarySlotService(db);
  const heartbeat = heartbeatService(db);

  async function assertSummariesEnabled() {
    const experimental = await settings.getExperimental();
    if (experimental.enableSummaries !== true) {
      throw notFound("Summaries are not enabled");
    }
  }

  /** Manual generate is a board/user action; agents cannot trigger it. */
  async function assertCanGenerateSummary(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") {
      throw forbidden("Only board operators can generate summaries.");
    }
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const allowed = await access.canUser(companyId, req.actor.userId, "tasks:assign");
    if (!allowed) {
      throw forbidden("Missing permission: tasks:assign");
    }
  }

  async function logSummaryMutation(
    req: Request,
    input: {
      companyId: string;
      action: "summary_slot.generate_requested" | "summary_slot.write";
      slotId: string;
      details: Record<string, unknown>;
    },
  ) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: input.action,
      entityType: "summary_slot",
      entityId: input.slotId,
      ...(actor.agentId ? { agentId: actor.agentId } : {}),
      ...(actor.runId ? { runId: actor.runId } : {}),
      details: input.details,
    });
  }

  router.get("/companies/:companyId/summary-slots/:scopeKind/:slotKey", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertSummariesEnabled();
    const result = await svc.getSlot({
      companyId,
      scopeKind: req.params.scopeKind as string,
      slotKey: req.params.slotKey as string,
      scopeId: readScopeId(req),
    });
    res.json(result);
  });

  router.get("/companies/:companyId/summary-slots/:scopeKind/:slotKey/revisions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertSummariesEnabled();
    const result = await svc.listRevisions({
      companyId,
      scopeKind: req.params.scopeKind as string,
      slotKey: req.params.slotKey as string,
      scopeId: readScopeId(req),
    });
    res.json(result);
  });

  router.post(
    "/companies/:companyId/summary-slots/:scopeKind/:slotKey/generate",
    validate(generateSummarySlotSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertSummariesEnabled();
      await assertCanGenerateSummary(req, companyId);
      const actor = getActorInfo(req);
      const result = await svc.generate(
        {
          companyId,
          scopeKind: req.params.scopeKind as string,
          slotKey: req.params.slotKey as string,
          scopeId: (req.body?.scopeId as string | null | undefined) ?? readScopeId(req),
        },
        {
          agentId: actor.actorType === "agent" ? actor.actorId : null,
          userId: actor.actorType === "user" ? actor.actorId : null,
          runId: actor.runId ?? null,
        },
      );
      await logSummaryMutation(req, {
        companyId,
        action: "summary_slot.generate_requested",
        slotId: result.slot.id,
        details: {
          scopeKind: result.slot.scopeKind,
          scopeId: result.slot.scopeId,
          slotKey: result.slot.slotKey,
          generatingIssueId: result.generatingIssue.id,
          alreadyGenerating: result.alreadyGenerating,
        },
      });
      if (!result.alreadyGenerating) {
        await queueIssueAssignmentWakeup({
          heartbeat,
          issue: {
            id: result.generatingIssue.id,
            assigneeAgentId: result.generatingIssue.assigneeAgentId ?? null,
            status: result.generatingIssue.status,
          },
          reason: "summary_slot_generation_requested",
          mutation: "summary_slot.generate",
          contextSource: "summary-slot.generate",
          requestedByActorType: actor.actorType === "agent" ? "agent" : "user",
          requestedByActorId: actor.actorId,
          taskKey: summarySlotSessionTaskKey({
            companyId,
            scopeKind: result.slot.scopeKind,
            slotKey: result.slot.slotKey,
            scopeId: result.slot.scopeId,
          }),
          rethrowOnError: true,
        });
      }
      res.status(result.alreadyGenerating ? 200 : 202).json(result);
    },
  );

  router.put(
    "/companies/:companyId/summary-slots/:scopeKind/:slotKey",
    validate(writeSummarySlotSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      await assertSummariesEnabled();
      if (req.actor.type !== "agent") {
        throw forbidden("Only the Summarizer built-in agent may write summaries");
      }
      const actor = getActorInfo(req);
      const result = await svc.write(
        {
          companyId,
          scopeKind: req.params.scopeKind as string,
          slotKey: req.params.slotKey as string,
          scopeId: (req.body?.scopeId as string | null | undefined) ?? readScopeId(req),
          markdown: req.body.markdown,
          title: req.body.title ?? null,
          changeSummary: req.body.changeSummary ?? null,
          baseRevisionId: req.body.baseRevisionId ?? null,
          generationIssueId: req.body.generationIssueId ?? null,
          model: req.body.model ?? null,
        },
        {
          agentId: actor.agentId,
          runId: actor.runId ?? null,
        },
      );
      await logSummaryMutation(req, {
        companyId,
        action: "summary_slot.write",
        slotId: result.slot.id,
        details: {
          scopeKind: result.slot.scopeKind,
          scopeId: result.slot.scopeId,
          slotKey: result.slot.slotKey,
          documentId: result.document.id,
          revisionId: result.revision.id,
          revisionNumber: result.revision.revisionNumber,
        },
      });
      res.json(result);
    },
  );

  return router;
}
