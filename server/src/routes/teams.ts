import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { teamService } from "../services/teams.js";
import { logActivity } from "../services/activity-log.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

const createTeamSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullish(),
  departmentId: z.string().uuid().nullish(),
});

const updateTeamSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullish(),
  departmentId: z.string().uuid().nullish(),
});

const addMemberSchema = z.object({
  principalType: z.enum(["user", "agent"]),
  principalId: z.string().min(1),
  role: z.enum(["member", "lead"]).default("member"),
});

export function teamRoutes(db: Db) {
  const router = Router();
  const svc = teamService(db);

  router.get("/companies/:companyId/teams", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId);
    res.json(result);
  });

  router.get("/teams/:id", async (req, res) => {
    const team = await svc.getById(req.params.id as string);
    if (!team) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    assertCompanyAccess(req, team.companyId);
    res.json(team);
  });

  router.post(
    "/companies/:companyId/teams",
    validate(createTeamSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const team = await svc.create(companyId, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "team.created",
        entityType: "team",
        entityId: team.id,
        details: { name: team.name },
      });

      res.status(201).json(team);
    },
  );

  router.patch(
    "/teams/:id",
    validate(updateTeamSchema),
    async (req, res) => {
      const team = await svc.getById(req.params.id as string);
      if (!team) {
        res.status(404).json({ error: "Team not found" });
        return;
      }
      assertCompanyAccess(req, team.companyId);

      const updated = await svc.update(team.id, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: team.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "team.updated",
        entityType: "team",
        entityId: team.id,
        details: req.body,
      });

      res.json(updated);
    },
  );

  router.post("/teams/:id/archive", async (req, res) => {
    const team = await svc.getById(req.params.id as string);
    if (!team) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    assertCompanyAccess(req, team.companyId);

    const archived = await svc.archive(team.id);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: team.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "team.archived",
      entityType: "team",
      entityId: team.id,
      details: { name: team.name },
    });

    res.json(archived);
  });

  router.get("/teams/:id/members", async (req, res) => {
    const team = await svc.getById(req.params.id as string);
    if (!team) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    assertCompanyAccess(req, team.companyId);
    const members = await svc.listMembers(team.id);
    res.json(members);
  });

  router.post(
    "/teams/:id/members",
    validate(addMemberSchema),
    async (req, res) => {
      const team = await svc.getById(req.params.id as string);
      if (!team) {
        res.status(404).json({ error: "Team not found" });
        return;
      }
      assertCompanyAccess(req, team.companyId);

      const membership = await svc.addMember(team.id, team.companyId, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: team.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "team.member_added",
        entityType: "team",
        entityId: team.id,
        details: { principalType: req.body.principalType, principalId: req.body.principalId, role: req.body.role },
      });

      res.status(201).json(membership);
    },
  );

  router.delete("/teams/:id/members/:principalType/:principalId", async (req, res) => {
    const team = await svc.getById(req.params.id as string);
    if (!team) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    assertCompanyAccess(req, team.companyId);

    await svc.removeMember(team.id, req.params.principalType as string, req.params.principalId as string);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: team.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "team.member_removed",
      entityType: "team",
      entityId: team.id,
      details: { principalType: req.params.principalType, principalId: req.params.principalId },
    });

    res.status(204).end();
  });

  return router;
}
