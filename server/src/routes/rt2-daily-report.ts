import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  listRt2DailyBoardSchema,
  rt2DailyReportDateSchema,
  updateRt2DailyCardLaneSchema,
  updateRt2DailyCardOkrSchema,
  updateRt2DailyCardQualitySchema,
  updateRt2DailyCardTitleSchema,
  upsertRt2DailyCardDeliverableSchema,
  upsertRt2DailyReportCardSchema,
} from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { publishLiveEvent } from "../services/live-events.js";
import { rt2DailyReportService } from "../services/rt2-daily-report.js";
import { rt2WikiLintService } from "../services/rt2-wiki-lint.js";
import { assertCompanyAccess } from "./authz.js";

const queryRt2DailyWikiRequestSchema = z.object({
  projectId: z.string().uuid(),
  reportDate: rt2DailyReportDateSchema,
  question: z.literal("오늘 뭐 했지?"),
});
const dailyCardEditContextSchema = z.object({
  projectId: z.string().uuid(),
  reportDate: rt2DailyReportDateSchema,
});
const updateRt2DailyCardTitleRequestSchema = dailyCardEditContextSchema.merge(updateRt2DailyCardTitleSchema);
const updateRt2DailyCardLaneRequestSchema = dailyCardEditContextSchema.merge(updateRt2DailyCardLaneSchema);
const upsertRt2DailyCardDeliverableRequestSchema = dailyCardEditContextSchema.merge(upsertRt2DailyCardDeliverableSchema);
const updateRt2DailyCardQualityRequestSchema = dailyCardEditContextSchema.merge(updateRt2DailyCardQualitySchema);
const updateRt2DailyCardOkrRequestSchema = dailyCardEditContextSchema.merge(updateRt2DailyCardOkrSchema);

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
  const wikiLintSvc = rt2WikiLintService(db);

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

  router.patch(
    "/companies/:companyId/rt2/daily-report/cards/:todoIssueId/title",
    validate(updateRt2DailyCardTitleRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actorUserId = assertBoardActor(req);
      const { todoIssueId } = req.params as { todoIssueId: string };
      const saved = await svc.updateCardTitle(companyId, actorUserId, todoIssueId, req.body);
      res.json(saved);
    },
  );

  router.patch(
    "/companies/:companyId/rt2/daily-report/cards/:todoIssueId/lane",
    validate(updateRt2DailyCardLaneRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actorUserId = assertBoardActor(req);
      const { todoIssueId } = req.params as { todoIssueId: string };
      const saved = await svc.updateCardLane(companyId, actorUserId, todoIssueId, req.body);
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
          mutation: "lane_saved",
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

      res.json({ ...saved, wikiPage });
    },
  );

  router.put(
    "/companies/:companyId/rt2/daily-report/cards/:todoIssueId/deliverable",
    validate(upsertRt2DailyCardDeliverableRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actorUserId = assertBoardActor(req);
      const { todoIssueId } = req.params as { todoIssueId: string };
      const saved = await svc.upsertCardDeliverable(companyId, actorUserId, todoIssueId, req.body);
      res.json(saved);
    },
  );

  router.patch(
    "/companies/:companyId/rt2/daily-report/cards/:todoIssueId/quality",
    validate(updateRt2DailyCardQualityRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actorUserId = assertBoardActor(req);
      const { todoIssueId } = req.params as { todoIssueId: string };
      const saved = await svc.updateCardQuality(companyId, actorUserId, todoIssueId, req.body);
      res.json(saved);
    },
  );

  router.patch(
    "/companies/:companyId/rt2/daily-report/cards/:todoIssueId/okr",
    validate(updateRt2DailyCardOkrRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actorUserId = assertBoardActor(req);
      const { todoIssueId } = req.params as { todoIssueId: string };
      const saved = await svc.updateCardOkr(companyId, actorUserId, todoIssueId, req.body);
      res.json(saved);
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

  // M2.5: Wiki lint - check wiki pages for quality issues
  router.get("/companies/:companyId/rt2/wiki-lint", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const projectId = req.query.projectId as string;
    if (!projectId) {
      throw badRequest("projectId is required");
    }

    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;

    const result = await wikiLintSvc.lintWikiPages(companyId, projectId, startDate, endDate);
    res.json(result);
  });

  // M2.5: Wiki quality score (0-100)
  router.get("/companies/:companyId/rt2/wiki-quality-score", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const projectId = req.query.projectId as string;
    if (!projectId) {
      throw badRequest("projectId is required");
    }

    const score = await wikiLintSvc.getWikiQualityScore(companyId, projectId);
    res.json({ projectId, score });
  });

  return router;
}
