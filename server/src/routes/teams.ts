import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { teamService } from "../services/teams.js";
import { logActivity } from "../services/activity-log.js";
import { getActorInfo } from "./authz.js";
import { scopedCompanyAuthz } from "./scoped-company-authz.js";

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
  const scopedAuthz = scopedCompanyAuthz(db);

  router.get("/companies/:companyId/teams", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scope = await scopedAuthz.resolveScopedPermission(req, companyId, "teams:view");
    const result = await svc.list(companyId);
    res.json(
      scope.companyWide
        ? result
        : result.filter((team) => team.departmentId && scope.departmentIds.includes(team.departmentId)),
    );
  });

  router.get("/teams/:id", async (req, res) => {
    const team = await svc.getById(req.params.id as string);
    if (!team) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    await scopedAuthz.assertScopedPermission(req, team.companyId, "teams:view", team.departmentId);
    res.json(team);
  });

  router.post(
    "/companies/:companyId/teams",
    validate(createTeamSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await scopedAuthz.assertScopedPermission(req, companyId, "teams:manage", req.body.departmentId ?? null);

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
      await scopedAuthz.assertScopedPermission(req, team.companyId, "teams:manage", team.departmentId);
      if (req.body.departmentId !== undefined) {
        await scopedAuthz.assertScopedPermission(req, team.companyId, "teams:manage", req.body.departmentId);
      }

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
    await scopedAuthz.assertScopedPermission(req, team.companyId, "teams:manage", team.departmentId);

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
    await scopedAuthz.assertScopedPermission(req, team.companyId, "teams:view", team.departmentId);
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
      await scopedAuthz.assertScopedPermission(req, team.companyId, "teams:manage", team.departmentId);

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
    await scopedAuthz.assertScopedPermission(req, team.companyId, "teams:manage", team.departmentId);

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
