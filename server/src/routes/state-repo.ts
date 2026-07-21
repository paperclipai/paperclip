import { promises as fs } from "node:fs";
import path from "node:path";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import type { StateRepoService } from "../services/state-repo.js";
import { stateRepoRemoteService } from "../services/state-repo-remote.js";
import { logActivity } from "../services/activity-log.js";

export function stateRepoRoutes(db: Db, service: StateRepoService, markerDir: string) {
  const router = Router();
  const remotes = stateRepoRemoteService(db);

  router.get("/companies/:companyId/state-repo/log", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const limit = Number(req.query.limit);
    const commits = await service.log(companyId, Number.isFinite(limit) && limit > 0 ? limit : 50);
    res.json({ commits });
  });

  router.get("/companies/:companyId/state-repo/remote", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const remote = await remotes.get(companyId);
    res.json({ remote });
  });

  router.put("/companies/:companyId/state-repo/remote", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const remoteUrl = typeof req.body?.remoteUrl === "string" ? req.body.remoteUrl.trim() : "";
    if (!remoteUrl) {
      res.status(422).json({ error: "remoteUrl is required" });
      return;
    }
    if (!/^https:\/\//i.test(remoteUrl)) {
      res.status(422).json({ error: "remoteUrl must be an https:// URL" });
      return;
    }
    const secretId = typeof req.body?.secretId === "string" && req.body.secretId.trim() ? req.body.secretId.trim() : null;
    const rawVersion = req.body?.secretVersion;
    const secretVersion =
      rawVersion === "latest" || rawVersion == null
        ? "latest"
        : Number.isFinite(Number(rawVersion))
          ? String(Math.trunc(Number(rawVersion)))
          : "latest";
    const saved = await remotes.set(companyId, { remoteUrl, secretId, secretVersion });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "company.state_repo_remote_configured",
      entityType: "company",
      entityId: companyId,
      details: { remoteUrl, secretId, secretVersion },
    });
    res.json({ remote: saved });
  });

  router.delete("/companies/:companyId/state-repo/remote", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    await remotes.clear(companyId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "company.state_repo_remote_disconnected",
      entityType: "company",
      entityId: companyId,
      details: {},
    });
    res.json({ remote: null });
  });

  router.get("/companies/:companyId/state-repo/bundle", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await fs.mkdir(markerDir, { recursive: true });
    const outputPath = path.join(markerDir, `state-repo-${companyId}-${Date.now()}.bundle`);
    await service.exportBundle(companyId, outputPath);
    res.download(outputPath, `paperclip-state-${companyId}.bundle`, () => void fs.rm(outputPath, { force: true }));
  });

  router.post("/companies/:companyId/state-repo/mirror/test", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    await service.testMirror(companyId);
    res.json(await service.health(companyId));
  });

  router.get("/companies/:companyId/state-repo/health", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await service.health(companyId));
  });

  router.post("/companies/:companyId/state-repo/restore", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const source = typeof req.body?.source === "string" ? req.body.source.trim() : "";
    if (!source) {
      res.status(422).json({ error: "source is required" });
      return;
    }
    const result = await service.restore(companyId, source, req.body?.ref || "main", req.body?.dryRun === true);
    if (!result.dryRun) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "company.state_repo_restored",
        entityType: "company",
        entityId: companyId,
        details: { source, ref: req.body?.ref || "main", restoredCount: result.restored.length },
      });
    }
    res.json(result);
  });

  return router;
}
