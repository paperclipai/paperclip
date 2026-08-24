import { Router } from "express";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { agents, boardTokenExceptions, issues, type Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { HIGH_INPUT_TOKEN_RUN_THRESHOLD } from "../services/heartbeat.js";
import { logActivity } from "../services/activity-log.js";
import { assertBoard, assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";

const MAX_EXCEPTION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

const createBoardTokenExceptionSchema = z.object({
  issueId: z.string().uuid(),
  agentId: z.string().uuid().nullable().optional(),
  capTokens: z.number().int().safe().gt(HIGH_INPUT_TOKEN_RUN_THRESHOLD),
  reason: z.string().trim().min(1).max(2_000),
  expiresAt: z.coerce.date(),
}).strict();

const revokeBoardTokenExceptionSchema = z.object({
  reason: z.string().trim().min(1).max(2_000),
}).strict();

function sameGrant(
  existing: typeof boardTokenExceptions.$inferSelect,
  input: z.infer<typeof createBoardTokenExceptionSchema>,
) {
  return existing.capTokens === input.capTokens
    && existing.reason === input.reason
    && existing.expiresAt.getTime() === input.expiresAt.getTime();
}

/** Board-authenticated lifecycle for the narrow per-issue token ceiling override. */
export function boardTokenExceptionRoutes(db: Db) {
  const router = Router();

  router.post(
    "/companies/:companyId/board-token-exceptions",
    validate(createBoardTokenExceptionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const input = req.body as z.infer<typeof createBoardTokenExceptionSchema>;
      const now = new Date();
      if (input.expiresAt.getTime() <= now.getTime() || input.expiresAt.getTime() > now.getTime() + MAX_EXCEPTION_LIFETIME_MS) {
        res.status(422).json({ error: "Expiry must be in the future and no more than 30 days away" });
        return;
      }

      const issue = await db.select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, input.issueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!issue) {
        res.status(422).json({ error: "Issue must belong to the requested company" });
        return;
      }
      const agentId = input.agentId ?? null;
      if (agentId) {
        const agent = await db.select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!agent) {
          res.status(422).json({ error: "Agent must belong to the requested company" });
          return;
        }
      }

      const actor = getActorInfo(req);
      const result = await db.transaction(async (tx) => {
        const existing = await tx.select().from(boardTokenExceptions).where(and(
          eq(boardTokenExceptions.companyId, companyId),
          eq(boardTokenExceptions.issueId, input.issueId),
          agentId === null ? isNull(boardTokenExceptions.agentId) : eq(boardTokenExceptions.agentId, agentId),
          isNull(boardTokenExceptions.revokedAt),
          gt(boardTokenExceptions.expiresAt, now),
        )).then((rows) => rows[0] ?? null);
        if (existing) return { exception: existing, created: false, conflict: !sameGrant(existing, input) };

        // The unique unrevoked-scope index permits a later grant after expiry without
        // ever leaving two records eligible for the same issue/agent scope.
        await tx.update(boardTokenExceptions).set({
          revokedAt: now,
          revokedByUserId: actor.actorId,
          revokedByAgentId: null,
          revocationReason: "Expired exception superseded by a new board grant",
        }).where(and(
          eq(boardTokenExceptions.companyId, companyId),
          eq(boardTokenExceptions.issueId, input.issueId),
          agentId === null ? isNull(boardTokenExceptions.agentId) : eq(boardTokenExceptions.agentId, agentId),
          isNull(boardTokenExceptions.revokedAt),
        ));
        const exception = await tx.insert(boardTokenExceptions).values({
          companyId,
          issueId: input.issueId,
          agentId,
          capTokens: input.capTokens,
          reason: input.reason,
          expiresAt: input.expiresAt,
          createdByUserId: actor.actorId,
          createdByAgentId: null,
        }).returning().then((rows) => rows[0]!);
        return { exception, created: true, conflict: false };
      });
      if (result.conflict) {
        res.status(409).json({ error: "An active exception already exists for this issue and agent scope", exception: result.exception });
        return;
      }
      if (result.created) {
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          action: "board_token_exception.created",
          entityType: "board_token_exception",
          entityId: result.exception.id,
          issueId: input.issueId,
          details: { agentId, capTokens: input.capTokens, expiresAt: input.expiresAt.toISOString(), reason: input.reason },
        });
      }
      res.status(result.created ? 201 : 200).json(result.exception);
    },
  );

  router.post("/board-token-exceptions/:id/revoke", validate(revokeBoardTokenExceptionSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const exception = await db.select().from(boardTokenExceptions)
      .where(eq(boardTokenExceptions.id, id)).then((rows) => rows[0] ?? null);
    if (!exception || !hasCompanyAccess(req, exception.companyId)) {
      res.status(404).json({ error: "Board token exception not found" });
      return;
    }
    assertCompanyAccess(req, exception.companyId);
    if (exception.revokedAt) {
      res.status(409).json({ error: "Board token exception is already revoked" });
      return;
    }
    const actor = getActorInfo(req);
    const reason = (req.body as z.infer<typeof revokeBoardTokenExceptionSchema>).reason;
    const now = new Date();
    const revoked = await db.update(boardTokenExceptions).set({
      revokedAt: now,
      revokedByUserId: actor.actorId,
      revokedByAgentId: null,
      revocationReason: reason,
    }).where(and(eq(boardTokenExceptions.id, id), isNull(boardTokenExceptions.revokedAt))).returning()
      .then((rows) => rows[0] ?? null);
    if (!revoked) {
      res.status(409).json({ error: "Board token exception is already revoked" });
      return;
    }
    await logActivity(db, {
      companyId: revoked.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "board_token_exception.revoked",
      entityType: "board_token_exception",
      entityId: revoked.id,
      issueId: revoked.issueId,
      details: { reason },
    });
    res.json(revoked);
  });

  return router;
}

export { MAX_EXCEPTION_LIFETIME_MS };
