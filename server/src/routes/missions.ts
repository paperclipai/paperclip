import { Router } from "express";
import { missionEngine } from "../services/mission-engine.js";
import { createMissionSchema, updateMissionSchema } from "@paperclipai/shared";
// Temporary: import schemas directly since shared exports aren't resolving
// import { createMissionSchema, updateMissionSchema } from "../../../packages/shared/src/types/mission.js";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity } from "../services/index.js";
import type { Db } from "@paperclipai/db";

export function missionRoutes(db: Db) {
  const router = Router();
  const engine = missionEngine(db);

  router.get("/companies/:companyId/missions", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId as string);
    const missions = await engine.list(req.params.companyId as string);
    res.json({ missions });
  });

  router.post("/companies/:companyId/missions", validate(createMissionSchema), async (req, res) => {
    assertBoard(req);
    assertCompanyAccess(req, req.params.companyId as string);
    const mission = await engine.create(
      req.params.companyId as string,
      req.actor.userId ?? "board",
      req.body,
    );
    await logActivity(db, {
      companyId: req.params.companyId as string,
      actorType: "user", actorId: req.actor.userId ?? "board",
      action: "mission.created", entityType: "mission", entityId: mission.id,
      details: { title: mission.title },
    });
    res.status(201).json({ mission });
  });

  router.get("/companies/:companyId/missions/:missionId", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId as string);
    const mission = await engine.get(req.params.missionId as string);
    if (!mission) { res.status(404).json({ error: "Mission not found" }); return; }
    const spent = await engine.getBudgetSpent(req.params.missionId as string);
    res.json({ mission: { ...mission, budgetSpentUsd: spent } });
  });

  router.patch("/companies/:companyId/missions/:missionId", validate(updateMissionSchema), async (req, res) => {
    assertBoard(req);
    assertCompanyAccess(req, req.params.companyId as string);
    const mission = await engine.update(req.params.missionId as string, req.body);
    res.json({ mission });
  });

  // State transitions
  for (const event of ["launch", "pause", "resume", "complete"] as const) {
    router.patch(`/companies/:companyId/missions/:missionId/${event}`, async (req, res) => {
      assertBoard(req);
      assertCompanyAccess(req, req.params.companyId as string);
      const eventMap = { launch: "LAUNCH", pause: "PAUSE", resume: "RESUME", complete: "COMPLETE" } as const;
      try {
        const mission = await engine.transition(req.params.missionId as string, eventMap[event]);
        await logActivity(db, {
          companyId: req.params.companyId as string,
          actorType: "user", actorId: req.actor.userId ?? "board",
          action: `mission.${event}d`, entityType: "mission", entityId: mission.id,
          details: { status: mission.status },
        });
        res.json({ mission });
      } catch (e) {
        res.status(400).json({ error: (e as Error).message });
      }
    });
  }

  router.delete("/companies/:companyId/missions/:missionId", async (req, res) => {
    assertBoard(req);
    assertCompanyAccess(req, req.params.companyId);
    await engine.delete(req.params.missionId);
    res.status(204).send();
  });

  return router;
}
