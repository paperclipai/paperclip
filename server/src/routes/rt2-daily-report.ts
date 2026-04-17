import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  listRt2DailyBoardSchema,
  rt2DailyReportDateSchema,
  upsertRt2DailyReportCardSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { publishLiveEvent } from "../services/live-events.js";
import { rt2DailyReportService } from "../services/rt2-daily-report.js";
import { assertCompanyAccess } from "./authz.js";

const queryRt2DailyWikiRequestSchema = z.object({
  projectId: z.string().uuid(),
  reportDate: rt2DailyReportDateSchema,
  question: z.literal("오늘 뭐 했지?"),
});

function assertBoardActor(req: Request): string {
  if (req.actor.type !== "board" || !req.actor.userId) {
    throw forbidden("Board user required");
  }
  return req.actor.userId;
}

function parseDailyBoardQuery(req: Request) {
  return listRt2DailyBoardSchema.parse(req.query);
}

function emitLiveEventSafely(input: Parameters<typeof publishLiveEvent>[0]) {
  try {
    publishLiveEvent(input);
  } catch {
    // Best effort only. A throwing listener must not break the save path.
  }
}

export function rt2DailyReportRoutes(db: Db) {
  const router = Router();
  const svc = rt2DailyReportService(db);

  router.get("/companies/:companyId/rt2/daily-report", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actorUserId = assertBoardActor(req);
    const { projectId, reportDate } = parseDailyBoardQuery(req);
    const board = await svc.listDailyBoard(companyId, actorUserId, projectId, reportDate);
    res.json(board);
  });

  router.put(
    "/companies/:companyId/rt2/daily-report/cards/:todoIssueId",
    validate(upsertRt2DailyReportCardSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actorUserId = assertBoardActor(req);
      const { todoIssueId } = req.params as { todoIssueId: string };
      const saved = await svc.saveDailyCard(companyId, actorUserId, todoIssueId, req.body);
      const wikiPage = await svc.materializeDailyWikiPage(
        companyId,
        req.body.projectId,
        actorUserId,
        req.body.reportDate,
      );

      emitLiveEventSafely({
        companyId,
        type: "rt2.daily-report.updated",
        payload: {
          projectId: req.body.projectId,
          reportDate: req.body.reportDate,
          todoIssueId,
          userId: actorUserId,
          mutation: "saved",
        },
      });
      emitLiveEventSafely({
        companyId,
        type: "rt2.daily-wiki.updated",
        payload: {
          projectId: wikiPage.projectId,
          reportDate: wikiPage.reportDate,
          pageKey: wikiPage.pageKey,
          userId: actorUserId,
          mutation: "materialized",
        },
      });

      res.json({
        card: saved.card,
        wikiPage,
      });
    },
  );

  router.get("/companies/:companyId/rt2/daily-wiki", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actorUserId = assertBoardActor(req);
    const { projectId, reportDate } = parseDailyBoardQuery(req);
    const page = await svc.materializeDailyWikiPage(companyId, projectId, actorUserId, reportDate);
    res.json(page);
  });

  router.post(
    "/companies/:companyId/rt2/daily-wiki/query",
    validate(queryRt2DailyWikiRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actorUserId = assertBoardActor(req);
      const { projectId, reportDate } = req.body;
      const answer = await svc.queryDailyWiki(companyId, projectId, actorUserId, reportDate);
      res.json(answer);
    },
  );

  return router;
}
