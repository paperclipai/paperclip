import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createGoalRelationSchema,
  createGoalTargetSchema,
  createRoadmapBlockEdgeSchema,
  createRoadmapBlockSchema,
  promoteRoadmapBlockSchema,
  updateGoalTargetSchema,
  updateRoadmapBlockSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { goalRelationService, goalTargetService, roadmapService } from "../services/goal-platform.js";
import { goalService } from "../services/goals.js";
import { assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

/** Goals, targets, relations, and the roadmap are the human planning layer. */
export function assertHumanPlanningActor(req: Request) {
  const actor = getActorInfo(req);
  if (actor.actorType === "agent") {
    throw forbidden("The goal planning layer (goals, targets, relations, roadmap) is managed by humans");
  }
}

export function goalPlatformRoutes(db: Db) {
  const router = Router();
  const targets = goalTargetService(db);
  const relations = goalRelationService(db);
  const roadmap = roadmapService(db);
  const goalsSvc = goalService(db);

  // ---- Goal targets ----

  router.get("/companies/:companyId/goal-targets", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await targets.list(companyId));
  });

  router.post("/goals/:id/targets", validate(createGoalTargetSchema), async (req, res) => {
    const goalId = req.params.id as string;
    const goal = await getAccessibleResource(req, res, goalsSvc.getById(goalId), "Goal not found");
    if (!goal) return;
    assertHumanPlanningActor(req);
    res.status(201).json(await targets.create(goalId, req.body));
  });

  router.patch("/goal-targets/:id", validate(updateGoalTargetSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, targets.getById(id), "Goal target not found");
    if (!existing) return;
    assertHumanPlanningActor(req);
    res.json(await targets.update(id, req.body));
  });

  router.delete("/goal-targets/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, targets.getById(id), "Goal target not found");
    if (!existing) return;
    assertHumanPlanningActor(req);
    res.json(await targets.remove(id));
  });

  // ---- Goal relations (serves) ----

  router.get("/companies/:companyId/goal-relations", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await relations.list(companyId));
  });

  router.post("/companies/:companyId/goal-relations", validate(createGoalRelationSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertHumanPlanningActor(req);
    res.status(201).json(await relations.create(companyId, req.body));
  });

  router.delete("/goal-relations/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, relations.getById(id), "Goal relation not found");
    if (!existing) return;
    assertHumanPlanningActor(req);
    res.json(await relations.remove(id));
  });

  // ---- Roadmap ----

  router.get("/companies/:companyId/roadmap", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await roadmap.get(companyId));
  });

  router.post("/companies/:companyId/roadmap-blocks", validate(createRoadmapBlockSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertHumanPlanningActor(req);
    res.status(201).json(await roadmap.createBlock(companyId, req.body));
  });

  router.patch("/roadmap-blocks/:id", validate(updateRoadmapBlockSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, roadmap.getBlockById(id), "Roadmap block not found");
    if (!existing) return;
    assertHumanPlanningActor(req);
    res.json(await roadmap.updateBlock(id, req.body));
  });

  router.delete("/roadmap-blocks/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, roadmap.getBlockById(id), "Roadmap block not found");
    if (!existing) return;
    assertHumanPlanningActor(req);
    res.json(await roadmap.removeBlock(id));
  });

  router.post("/companies/:companyId/roadmap-block-edges", validate(createRoadmapBlockEdgeSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertHumanPlanningActor(req);
    res.status(201).json(await roadmap.createEdge(companyId, req.body));
  });

  router.delete("/roadmap-block-edges/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, roadmap.getEdgeById(id), "Roadmap edge not found");
    if (!existing) return;
    assertHumanPlanningActor(req);
    res.json(await roadmap.removeEdge(id));
  });

  router.post("/roadmap-blocks/:id/promote", validate(promoteRoadmapBlockSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, roadmap.getBlockById(id), "Roadmap block not found");
    if (!existing) return;
    assertHumanPlanningActor(req);
    res.status(201).json(await roadmap.promoteBlock(id, req.body));
  });

  return router;
}
