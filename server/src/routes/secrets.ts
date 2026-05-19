import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createSecretProviderConfigSchema,
  createSecretSchema,
  remoteSecretImportPreviewSchema,
  remoteSecretImportSchema,
  rotateSecretSchema,
  updateSecretProviderConfigSchema,
  updateSecretSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity, secretService } from "../services/index.js";
import { getConfiguredSecretProvider } from "../secrets/configured-provider.js";

export function secretRoutes(db: Db) {
  const router = Router();
  const svc = secretService(db);
  const defaultProvider = getConfiguredSecretProvider();

  router.get("/companies/:companyId/secret-providers", (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(svc.listProviders());
  });

  router.get("/companies/:companyId/secret-providers/health", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const checks = await svc.checkProviders();
    res.json({ providers: checks });
  });

  router.get("/companies/:companyId/secret-provider-configs", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listProviderConfigs(companyId));
  });

  router.post("/companies/:companyId/secret-provider-configs", validate(createSecretProviderConfigSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const created = await svc.createProviderConfig(
      companyId,
      {
        provider: req.body.provider,
        displayName: req.body.displayName,
        status: req.body.status,
        isDefault: req.body.isDefault,
        config: req.body.config,
      },
      { userId: req.actor.userId ?? "board", agentId: null },
    );

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret_provider_config.created",
      entityType: "secret_provider_config",
      entityId: created.id,
      details: {
        provider: created.provider,
        displayName: created.displayName,
        status: created.status,
        isDefault: created.isDefault,
      },
    });

    res.status(201).json(created);
  });

  router.get("/secret-provider-configs/:id", async (req, res) => {
    assertBoard(req);
    const existing = await svc.getProviderConfigById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    res.json(existing);
  });

  router.patch("/secret-provider-configs/:id", validate(updateSecretProviderConfigSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getProviderConfigById(id);
    if (!existing) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const updated = await svc.updateProviderConfig(id, {
      displayName: req.body.displayName,
      status: req.body.status,
      isDefault: req.body.isDefault,
      config: req.body.config,
    });
    if (!updated) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret_provider_config.updated",
      entityType: "secret_provider_config",
      entityId: updated.id,
      details: {
        provider: updated.provider,
        displayName: updated.displayName,
        status: updated.status,
        isDefault: updated.isDefault,
      },
    });

    res.json(updated);
  });

  router.delete("/secret-provider-configs/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getProviderConfigById(id);
    if (!existing) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const disabled = await svc.disableProviderConfig(id);
    if (!disabled) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }

    await logActivity(db, {
      companyId: disabled.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret_provider_config.disabled",
      entityType: "secret_provider_config",
      entityId: disabled.id,
      details: {
        provider: disabled.provider,
        displayName: disabled.displayName,
        status: disabled.status,
      },
    });

    res.json(disabled);
  });

  router.post("/secret-provider-configs/:id/default", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getProviderConfigById(id);
    if (!existing) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const updated = await svc.setDefaultProviderConfig(id);
    if (!updated) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret_provider_config.default_set",
      entityType: "secret_provider_config",
      entityId: updated.id,
      details: {
        provider: updated.provider,
        displayName: updated.displayName,
        isDefault: updated.isDefault,
      },
    });

    res.json(updated);
  });

  router.post("/secret-provider-configs/:id/health", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getProviderConfigById(id);
    if (!existing) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const health = await svc.checkProviderConfigHealth(id);
    if (!health) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret_provider_config.health_checked",
      entityType: "secret_provider_config",
      entityId: existing.id,
      details: {
        provider: existing.provider,
        status: health.status,
        code: health.details.code,
      },
    });

    res.json(health);
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
        key: req.body.key,
        provider: req.body.provider ?? defaultProvider,
        providerConfigId: req.body.providerConfigId,
        managedMode: req.body.managedMode,
        value: req.body.value,
        description: req.body.description,
        externalRef: req.body.externalRef,
        providerVersionRef: req.body.providerVersionRef,
        providerMetadata: req.body.providerMetadata,
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

  router.post(
    "/companies/:companyId/secrets/remote-import/preview",
    validate(remoteSecretImportPreviewSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const preview = await svc.previewRemoteImport(companyId, {
        providerConfigId: req.body.providerConfigId,
        query: req.body.query,
        nextToken: req.body.nextToken,
        pageSize: req.body.pageSize,
      });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "secret.remote_import.previewed",
        entityType: "secret_provider_config",
        entityId: preview.providerConfigId,
        details: {
          provider: preview.provider,
          candidateCount: preview.candidates.length,
          readyCount: preview.candidates.filter((candidate) => candidate.status === "ready").length,
          duplicateCount: preview.candidates.filter((candidate) => candidate.status === "duplicate").length,
          conflictCount: preview.candidates.filter((candidate) => candidate.status === "conflict").length,
        },
      });

      res.json(preview);
    },
  );

  router.post(
    "/companies/:companyId/secrets/remote-import",
    validate(remoteSecretImportSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const result = await svc.importRemoteSecrets(
        companyId,
        {
          providerConfigId: req.body.providerConfigId,
          secrets: req.body.secrets,
        },
        { userId: req.actor.userId ?? "board", agentId: null },
      );

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "secret.remote_import.completed",
        entityType: "secret_provider_config",
        entityId: result.providerConfigId,
        details: {
          provider: result.provider,
          importedCount: result.importedCount,
          skippedCount: result.skippedCount,
          errorCount: result.errorCount,
        },
      });

      res.json(result);
    },
  );

  router.post("/secrets/:id/rotate", validate(rotateSecretSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (existing.status === "deleted") {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    const rotated = await svc.rotate(
      id,
      {
        value: req.body.value,
        externalRef: req.body.externalRef,
        providerVersionRef: req.body.providerVersionRef,
        providerConfigId: req.body.providerConfigId,
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
    if (existing.status === "deleted") {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    const updated = await svc.update(id, {
      name: req.body.name,
      key: req.body.key,
      status: req.body.status,
      providerConfigId: req.body.providerConfigId,
      description: req.body.description,
      externalRef: req.body.externalRef,
      providerMetadata: req.body.providerMetadata,
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

  router.get("/secrets/:id/usage", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const bindings = await svc.listBindingReferences(existing.companyId, existing.id);
    res.json({ secretId: existing.id, bindings });
  });

  router.get("/secrets/:id/access-events", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const events = await svc.listAccessEvents(existing.companyId, existing.id);
    res.json(events);
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

  return router;
}
