import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  ATTENTION_SOURCE_KINDS,
  DECISION_HISTORY_SCOPES,
  attentionCloseSchema,
  attentionTransferSchema,
  type AttentionCloseResult,
  type AttentionFeedView,
  type AttentionSortMode,
  type AttentionSourceKind,
  type AttentionTransferResult,
} from "@paperclipai/shared";
import { attentionService } from "../services/attention.js";
import {
  attentionHandledDetails,
  attentionHandledFor,
  attentionReceiptService,
  type AttentionHandledSourceKind,
} from "../services/attention-receipts.js";
import { decisionHistoryService } from "../services/decision-history.js";
import { decisionService, type DecisionServiceOptions } from "../services/decisions.js";
import { createDecisionWakeOriginAgent } from "../services/decision-wakeup.js";
import { heartbeatService } from "../services/heartbeat.js";
import { logActivity } from "../services/activity-log.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { validate } from "../middleware/validate.js";
import { z } from "zod";
import { badRequest, HttpError } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { cancelApprovalAndNotify } from "./approvals.js";
import { withdrawIssueThreadInteractionAndNotify } from "./issues.js";

const ATTENTION_FEED_VIEWS: readonly AttentionFeedView[] = ["mine", "unassigned", "company", "archived", "all"];

function optionalQueryString(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${field} must be a non-empty string`);
  return value.trim();
}

export function attentionRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager; decisionServiceOptions?: DecisionServiceOptions } = {},
) {
  const router = Router();
  const svc = attentionService(db);
  const heartbeat = heartbeatService(db, { pluginWorkerManager: options.pluginWorkerManager });
  const decisions = decisionService(db, options.decisionServiceOptions ?? {
    wakeOriginAgent: createDecisionWakeOriginAgent(heartbeat.wakeup),
  });

  /** Board user on a company card route; returns the source the path names. */
  function cardRequest(req: Request) {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const userId = req.actor.userId;
    const sourceKind = req.params.sourceKind as string;
    if (!(ATTENTION_SOURCE_KINDS as readonly string[]).includes(sourceKind)) {
      throw badRequest(`sourceKind must be one of ${ATTENTION_SOURCE_KINDS.join(", ")}`);
    }
    const sourceId = req.params.sourceId as string;
    if (!z.string().uuid().safeParse(sourceId).success) throw badRequest("sourceId must be a UUID");
    return { companyId, userId, sourceKind: sourceKind as AttentionSourceKind, sourceId };
  }

  router.get("/companies/:companyId/attention/summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!req.actor.userId) { res.status(403).json({ error: "Board user context required" }); return; }
    res.json(await svc.summary(companyId, { userId: req.actor.userId, actor: req.actor }));
  });

  router.get("/companies/:companyId/attention/tasks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!req.actor.userId) { res.status(403).json({ error: "Board user context required" }); return; }
    res.json(await svc.taskIndex(companyId, { userId: req.actor.userId, actor: req.actor }));
  });

  router.get("/companies/:companyId/attention/history", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!req.actor.userId) { res.status(403).json({ error: "Board user context required" }); return; }
    const query = z.object({
      cursor: z.string().max(1000).optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
      search: z.string().trim().max(200).optional(), outcome: z.string().max(40).optional(),
      agentId: z.string().uuid().optional(), projectId: z.string().uuid().optional(),
      sort: z.enum(["newest", "oldest"]).optional(), since: z.string().datetime().optional(),
      // "Handled for me" (PAP-749 plan §6).
      handledForMe: z.enum(["true", "false"]).optional(),
      // "Handled by me or for me", or everyone's history (PAP-768).
      scope: z.enum(DECISION_HISTORY_SCOPES).optional(),
    }).strict().safeParse(req.query);
    if (!query.success) throw badRequest("Invalid decision history filters");
    const { handledForMe, ...filters } = query.data;
    res.json(await decisionHistoryService(db).list(companyId, {
      ...filters,
      handledForMe: handledForMe === "true",
      actor: req.actor,
      userId: req.actor.userId,
    }));
  });

  router.get("/companies/:companyId/attention", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }

    const includeDismissed = req.query.includeDismissed === "true";
    const archived = req.query.archived === "true";
    const all = req.query.all === "true";
    const viewValue = optionalQueryString(req.query.view, "view");
    if (viewValue !== undefined && !ATTENTION_FEED_VIEWS.includes(viewValue as AttentionFeedView)) {
      throw badRequest(`view must be one of ${ATTENTION_FEED_VIEWS.join(", ")}`);
    }
    const view = viewValue as AttentionFeedView | undefined;
    const activitySince = optionalQueryString(req.query.activitySince, "activitySince");
    const activityUntil = optionalQueryString(req.query.activityUntil, "activityUntil");
    const queue = optionalQueryString(req.query.queue, "queue");
    const cursor = optionalQueryString(req.query.cursor, "cursor");
    const sortValue = optionalQueryString(req.query.sort, "sort");
    if (sortValue !== undefined && sortValue !== "activity" && sortValue !== "decide") {
      throw badRequest("sort must be 'activity' or 'decide'");
    }
    const limitValue = optionalQueryString(req.query.limit, "limit");
    const limit = limitValue === undefined ? undefined : Number(limitValue);
    if (limit !== undefined && !Number.isInteger(limit)) throw badRequest("limit must be an integer");
    const feed = await svc.list(companyId, {
      userId: req.actor.userId,
      includeDismissed,
      actor: req.actor,
      archived,
      view,
      all,
      allowUnscopedAll: all,
      activitySince,
      activityUntil,
      queue,
      cursor,
      sort: sortValue as AttentionSortMode | undefined,
      limit,
    });
    // Receipts sit at the top of For you only (PAP-749 plan §6, Rule 12).
    if (view === "mine") {
      feed.receipts = await attentionReceiptService(db).list(companyId, { userId: req.actor.userId, actor: req.actor });
    }
    res.json(feed);
  });

  // Claim an Unassigned card (PAP-749 plan §1, Rule 3): the claimer becomes the
  // addressee, so the card leaves every other person's pool. Board users only;
  // it changes where the card shows, never who may answer it.
  router.post("/companies/:companyId/attention/:sourceKind/:sourceId/claim", async (req, res) => {
    const { companyId, userId, sourceKind, sourceId } = cardRequest(req);
    if (!userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }

    const claim = await svc.claim(companyId, { sourceKind, sourceId, userId, actor: req.actor });
    if (!claim.alreadyClaimed) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "attention.claimed",
        entityType: "issue",
        entityId: claim.issueId,
        issueId: claim.issueId,
        details: {
          sourceKind: claim.sourceKind,
          sourceId: claim.sourceId,
          interactionId: claim.sourceId,
          claimedByUserId: claim.claimedByUserId,
          previousAddresseeAgentId: claim.previousAddresseeAgentId,
        },
      });
    }
    res.json({
      sourceKind: claim.sourceKind,
      sourceId: claim.sourceId,
      claimedByUserId: claim.claimedByUserId,
      alreadyClaimed: claim.alreadyClaimed,
    });
  });

  // One Close… menu for every card (PAP-749 plan §2, Rule 6). Withdraw runs
  // the source owner's own withdraw or cancel, which writes its own activity
  // and tells the agent; archive and snooze hide the card for this person
  // only. Every close writes one `attention.closed` entry. Board users only.
  router.post(
    "/companies/:companyId/attention/:sourceKind/:sourceId/close",
    validate(attentionCloseSchema),
    async (req, res) => {
      const { companyId, userId, sourceKind, sourceId } = cardRequest(req);
      if (!userId) {
        res.status(403).json({ error: "Board user context required" });
        return;
      }
      const body = req.body as { mode: "withdraw" | "archive" | "snooze"; reason?: string | null; until?: string | null; fingerprint?: string | null };
      const reason = body.reason?.trim() || null;
      let issueId: string | null;
      let until: string | null = null;
      let details: Record<string, unknown> = {};

      if (body.mode === "withdraw") {
        const target = await svc.withdrawTarget(companyId, { sourceKind, sourceId, actor: req.actor });
        issueId = target.issueId;
        // Who the card was for, read before the withdraw closes it, so that
        // person gets "Withdrawn by @x" (PAP-749 plan §6, Rule 12).
        const handledFor = await attentionHandledFor(
          db, companyId, { sourceKind: target.sourceKind as AttentionHandledSourceKind, sourceId }, userId,
        );
        details = attentionHandledDetails(handledFor, "withdrawn", { reason });
        // A different person may answer between the check and the write. The
        // first answer wins; the second person gets "Already answered by @x".
        try {
          if (target.sourceKind === "issue_thread_interaction") {
            await withdrawIssueThreadInteractionAndNotify({
              db,
              heartbeat,
              issue: target.issue,
              interactionId: sourceId,
              body: { reason: reason ?? undefined },
              actor: getActorInfo(req),
              allowClosedIssueForHuman: true,
              handledFor,
            });
          } else if (target.sourceKind === "approval") {
            await cancelApprovalAndNotify({ db, heartbeat, approvalId: sourceId, userId, reason, handledFor });
          } else {
            await decisions.cancel(sourceId, { actorType: "user", actorId: userId }, {
              reason,
              activityDetails: attentionHandledDetails(handledFor, "withdrawn", { reason }),
            });
          }
        } catch (error) {
          if (error instanceof HttpError && error.status === 409) {
            throw (await svc.alreadyClosedError(companyId, { sourceKind, sourceId, actor: req.actor })) ?? error;
          }
          throw error;
        }
      } else {
        const hidden = await svc.hideForUser(companyId, {
          sourceKind,
          sourceId,
          userId,
          actor: req.actor,
          mode: body.mode,
          until: body.until,
          fingerprint: body.fingerprint,
        });
        issueId = hidden.issueId;
        until = hidden.until;
        details = { itemKey: hidden.itemKey, fingerprint: hidden.fingerprint };
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "attention.closed",
        entityType: issueId ? "issue" : "company",
        entityId: issueId ?? companyId,
        issueId,
        details: { sourceKind, sourceId, mode: body.mode, reason, until, closedByUserId: userId, ...details },
      });
      const result: AttentionCloseResult = { sourceKind, sourceId, mode: body.mode, closedByUserId: userId, issueId, until };
      res.json(result);
    },
  );

  // Transfer a card to a different person, "Route to @x" (PAP-749 plan §2,
  // Rule 6). The new owner becomes the addressee. Board users only.
  router.post(
    "/companies/:companyId/attention/:sourceKind/:sourceId/transfer",
    validate(attentionTransferSchema),
    async (req, res) => {
      const { companyId, userId, sourceKind, sourceId } = cardRequest(req);
      if (!userId) {
        res.status(403).json({ error: "Board user context required" });
        return;
      }
      const body = req.body as { userId: string; reason?: string | null };
      // The person the card was for before the transfer gets "Transferred to
      // @y by @x" (PAP-749 plan §6, Rule 12).
      const handledFor = sourceKind === "issue_thread_interaction"
        ? await attentionHandledFor(db, companyId, { sourceKind, sourceId }, userId)
        : null;
      const transfer = await svc.transfer(companyId, { sourceKind, sourceId, toUserId: body.userId, actor: req.actor });
      if (!transfer.alreadyTransferred) {
        const reason = body.reason?.trim() || null;
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "attention.transferred",
          entityType: "issue",
          entityId: transfer.issueId,
          issueId: transfer.issueId,
          details: {
            sourceKind: transfer.sourceKind,
            sourceId: transfer.sourceId,
            interactionId: transfer.sourceId,
            transferredToUserId: transfer.transferredToUserId,
            transferredByUserId: userId,
            previousAddresseeUserId: transfer.previousAddresseeUserId,
            previousAddresseeAgentId: transfer.previousAddresseeAgentId,
            reason,
            // No receipt when the card goes back to the same person.
            ...(handledFor?.userId === transfer.transferredToUserId
              ? {}
              : attentionHandledDetails(handledFor, "transferred", { reason, transferredToUserId: transfer.transferredToUserId })),
          },
        });
      }
      const result: AttentionTransferResult = {
        sourceKind: transfer.sourceKind,
        sourceId: transfer.sourceId,
        transferredToUserId: transfer.transferredToUserId,
        previousAddresseeUserId: transfer.previousAddresseeUserId,
        alreadyTransferred: transfer.alreadyTransferred,
      };
      res.json(result);
    },
  );

  return router;
}
