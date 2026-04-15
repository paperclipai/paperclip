import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import type { BoardBriefSnapshot } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { agentService, boardBriefService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function boardBriefRoutes(db: Db) {
  const router = Router();
  const briefs = boardBriefService(db);
  const agents = agentService(db);

  async function assertCanReadBoardBrief(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");
    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actorAgent.role !== "ceo") {
      throw forbidden("Only CEO agents can read board brief reports");
    }
  }

  router.get("/companies/:companyId/board-brief", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanReadBoardBrief(req, companyId);
    const brief = await briefs.build(companyId);
    res.json(brief);
  });

  router.get("/companies/:companyId/board-brief/history", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanReadBoardBrief(req, companyId);
    const limit = parsePositiveInteger(req.query.limit);
    const source = typeof req.query.source === "string" ? req.query.source : undefined;
    const history = await briefs.listHistory(companyId, {
      limit,
      source: source as BoardBriefSnapshot["source"] | undefined,
    });
    res.json(history);
  });

  return router;
}
