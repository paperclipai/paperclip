import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  getRt2CorpusGraphCommunitySchema,
  getRt2CorpusGraphNodeSchema,
  getRt2CorpusGraphShortestPathSchema,
  ingestRt2CorpusGraphSchema,
  listRt2CorpusGraphNeighborsSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { rt2CorpusGraphService } from "../services/rt2-corpus-graph.js";
import { assertCompanyAccess } from "./authz.js";

export function rt2CorpusGraphRoutes(db: Db) {
  const router = Router();
  const svc = rt2CorpusGraphService(db);

  router.post("/companies/:companyId/rt2/corpus-graph/ingest", validate(ingestRt2CorpusGraphSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.ingestSources(companyId, req.body);
    res.json(result);
  });

  router.get("/companies/:companyId/rt2/corpus-graph/stats", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getStats(companyId));
  });

  router.get("/companies/:companyId/rt2/corpus-graph/report", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getReport(companyId));
  });

  router.get("/companies/:companyId/rt2/corpus-graph/node", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = getRt2CorpusGraphNodeSchema.parse(req.query);
    res.json(await svc.getNode(companyId, query.nodeKey));
  });

  router.get("/companies/:companyId/rt2/corpus-graph/neighbors", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = listRt2CorpusGraphNeighborsSchema.parse(req.query);
    res.json(await svc.getNeighbors(companyId, query.nodeKey, query.limit));
  });

  router.get("/companies/:companyId/rt2/corpus-graph/community", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = getRt2CorpusGraphCommunitySchema.parse(req.query);
    res.json(await svc.getCommunity(companyId, query.communityKey));
  });

  router.get("/companies/:companyId/rt2/corpus-graph/shortest-path", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = getRt2CorpusGraphShortestPathSchema.parse(req.query);
    res.json(await svc.getShortestPath(companyId, query.fromNodeKey, query.toNodeKey, query.maxDepth));
  });

  router.get("/companies/:companyId/rt2/corpus-graph/god-nodes", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 10), 1), 100);
    res.json({ companyId, nodes: await svc.getGodNodes(companyId, limit) });
  });

  return router;
}
