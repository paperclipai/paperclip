import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  SECRET_PROVIDERS,
  type SecretProvider,
  createSecretSchema,
  rotateSecretSchema,
  updateSecretSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess, assertAuthenticated } from "./authz.js";
import { logActivity, secretService, agentService, issueService } from "../services/index.js";
import {
  checkAcl,
  logAccessDenied,
  queueAccessLogRead,
  startAccessLogFlusher,
} from "../services/secret-access-log.js";
import { scrubSecretValues } from "../output_scrubber.js";

export function secretRoutes(db: Db) {
  const router = Router();
  const svc = secretService(db);
  const configuredDefaultProvider = process.env.PAPERCLIP_SECRETS_PROVIDER;
  const defaultProvider = (
    configuredDefaultProvider && SECRET_PROVIDERS.includes(configuredDefaultProvider as SecretProvider)
      ? configuredDefaultProvider
      : "local_encrypted"
  ) as SecretProvider;

  router.get("/companies/:companyId/secret-providers", (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(svc.listProviders());
  });

  router.get("/companies/:companyId/secrets", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const secrets = await svc.list(companyId);
    res.json(secrets);
  });

  router.post("/companies/:companyId/secrets", validate(createSecretSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const created = await svc.create(
      companyId,
      {
        name: req.body.name,
        provider: req.body.provider ?? defaultProvider,
        value: req.body.value,
        description: req.body.description,
        externalRef: req.body.externalRef,
      },
      { userId: req.actor.userId ?? "board", agentId: null },
    );

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.created",
      entityType: "secret",
      entityId: created.id,
      details: { name: created.name, provider: created.provider },
    });

    res.status(201).json(created);
  });

  router.post("/secrets/:id/rotate", validate(rotateSecretSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const rotated = await svc.rotate(
      id,
      {
        value: req.body.value,
        externalRef: req.body.externalRef,
      },
      { userId: req.actor.userId ?? "board", agentId: null },
    );

    await logActivity(db, {
      companyId: rotated.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.rotated",
      entityType: "secret",
      entityId: rotated.id,
      details: { version: rotated.latestVersion },
    });

    res.json(rotated);
  });

  router.patch("/secrets/:id", validate(updateSecretSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const updated = await svc.update(id, {
      name: req.body.name,
      description: req.body.description,
      externalRef: req.body.externalRef,
    });

    if (!updated) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.updated",
      entityType: "secret",
      entityId: updated.id,
      details: { name: updated.name },
    });

    res.json(updated);
  });

  router.delete("/secrets/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const removed = await svc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    await logActivity(db, {
      companyId: removed.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.deleted",
      entityType: "secret",
      entityId: removed.id,
      details: { name: removed.name },
    });

    res.json({ ok: true });
  });

  let accessLogStarted = false;

  router.get("/secrets/:key", async (req, res) => {
    assertAuthenticated(req);

    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      res.status(403).json({ error: "Agent credentials required" });
      return;
    }

    const secretName = req.params.key as string;
    const { agentId, companyId } = req.actor;

    if (!accessLogStarted) {
      startAccessLogFlusher(db);
      accessLogStarted = true;
    }

    const secret = await svc.getByName(companyId, secretName);
    if (!secret) {
      const agent = await agentService(db).getById(agentId);
      const agentRole = agent?.role ?? "unknown";

      await issueService(db).create(companyId, {
        title: `[BOARD] SECRET-MISSING ${secretName}`,
        description: `Agent \`${agentId}\` (role: ${agentRole}) requested secret \`${secretName}\` but it does not exist.\n\nCreate the secret in the vault or grant the agent access to an existing secret.`,
        priority: "high",
        status: "todo",
        labelIds: [],
      });

      res.status(404).json({ error: "Secret not found", secretName });
      return;
    }

    const agent = await agentService(db).getById(agentId);
    const agentRole = agent?.role ?? "unknown";

    const aclResult = checkAcl(secret, agentId, agentRole);
    if (!aclResult.granted) {
      await logAccessDenied(db, {
        secretId: secret.id,
        secretName,
        companyId,
        actorAgentId: agentId,
        actorRole: agentRole,
        denialReason: aclResult.reason ?? "access_denied",
      });
      res.status(403).json({ error: "Access denied", reason: aclResult.reason });
      return;
    }

    queueAccessLogRead({
      secretId: secret.id,
      secretName,
      companyId,
      actorAgentId: agentId,
      actorRole: agentRole,
    });

    let secretValue: string;
    try {
      secretValue = await svc.resolveSecretValue(companyId, secret.id, "latest");
    } catch {
      res.status(500).json({ error: "Failed to resolve secret value" });
      return;
    }

    const scrubbedValue = scrubSecretValues(secretValue);

    res.json({
      name: secretName,
      value: scrubbedValue,
      provider: secret.provider,
      version: secret.latestVersion,
    });
  });

  return router;
}
