import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createGithubConnectionSchema, updateGithubConnectionSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { githubConnectionService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function githubConnectionRoutes(db: Db) {
  const router = Router();
  const svc = githubConnectionService(db);

  router.get("/companies/:companyId/github-connections", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId));
  });

  router.post(
    "/companies/:companyId/github-connections",
    validate(createGithubConnectionSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const created = await svc.create(companyId, req.body, {
        userId: actor.actorId,
        agentId: actor.agentId,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "github_connection.created",
        entityType: "github_connection",
        entityId: created.id,
        details: { name: created.name, hostname: created.hostname, secretId: created.secretId },
      });
      res.status(201).json(created);
    },
  );

  router.patch(
    "/companies/:companyId/github-connections/:connectionId",
    validate(updateGithubConnectionSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const updated = await svc.update(companyId, req.params.connectionId as string, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "github_connection.updated",
        entityType: "github_connection",
        entityId: updated.id,
        details: { changedKeys: Object.keys(req.body).sort() },
      });
      res.json(updated);
    },
  );

  router.post("/companies/:companyId/github-connections/:connectionId/test", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.test(companyId, req.params.connectionId as string);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "github_connection.tested",
      entityType: "github_connection",
      entityId: req.params.connectionId as string,
      details: { ok: result.ok, hostname: result.hostname, accountLogin: result.accountLogin },
    });
    res.status(result.ok ? 200 : 422).json(result);
  });

  router.delete("/companies/:companyId/github-connections/:connectionId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const removed = await svc.remove(companyId, req.params.connectionId as string);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "github_connection.deleted",
      entityType: "github_connection",
      entityId: removed.id,
      details: { name: removed.name },
    });
    res.json({ success: true });
  });

  return router;
}
