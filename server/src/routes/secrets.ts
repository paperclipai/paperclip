import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createSecretProviderConfigSchema,
  createSecretSchema,
  createUserSecretDefinitionSchema,
  createUserSecretValueSchema,
  remoteSecretImportPreviewSchema,
  remoteSecretImportSchema,
  rotateSecretSchema,
  rotateUserSecretValueSchema,
  secretProviderConfigDiscoveryPreviewSchema,
  updateSecretProviderConfigSchema,
  updateSecretSchema,
  updateUserSecretDefinitionSchema,
  updateUserSecretValueSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity, secretService } from "../services/index.js";
import { getConfiguredSecretProvider } from "../secrets/configured-provider.js";
import { forbidden } from "../errors.js";

function assertSecretDefinitionAdmin(req: Parameters<typeof assertBoard>[0], companyId: string) {
  assertBoard(req);
  assertCompanyAccess(req, companyId);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
  const membership = req.actor.memberships?.find((item) => item.companyId === companyId);
  if (membership?.status === "active" && ["owner", "admin"].includes(String(membership.membershipRole))) {
    return;
  }
  throw forbidden("Company admin access required");
}

function currentUserId(req: Parameters<typeof assertBoard>[0]) {
  assertBoard(req);
  return req.actor.userId ?? "board";
}

function isCompanyScopedSecret(secret: { scope?: string | null }) {
  return (secret.scope ?? "company") === "company";
}

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

  router.post(
    "/companies/:companyId/secret-provider-configs/discovery/preview",
    validate(secretProviderConfigDiscoveryPreviewSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const preview = await svc.previewProviderConfigDiscovery(companyId, {
        provider: req.body.provider,
        config: req.body.config,
        query: req.body.query,
        nextToken: req.body.nextToken,
        pageSize: req.body.pageSize,
      });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "secret_provider_config.discovery_previewed",
        entityType: "secret_provider_config_discovery",
        entityId: companyId,
        details: {
          provider: preview.provider,
          candidateCount: preview.candidates.length,
          sampledSecretCount: preview.sampledSecretCount,
          warningCount: preview.warnings.length,
        },
      });

      res.json(preview);
    },
  );

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

    const removed = await svc.removeProviderConfig(id);
    if (!removed) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }

    await logActivity(db, {
      companyId: removed.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret_provider_config.removed",
      entityType: "secret_provider_config",
      entityId: removed.id,
      details: {
        provider: removed.provider,
        displayName: removed.displayName,
        remoteDeleted: false,
      },
    });

    res.json(removed);
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

  router.get("/companies/:companyId/user-secret-definitions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertSecretDefinitionAdmin(req, companyId);
    res.json(await svc.listUserSecretDefinitions(companyId));
  });

  router.post(
    "/companies/:companyId/user-secret-definitions",
    validate(createUserSecretDefinitionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertSecretDefinitionAdmin(req, companyId);

      const created = await svc.createUserSecretDefinition(
        companyId,
        {
          key: req.body.key,
          name: req.body.name,
          description: req.body.description,
          status: req.body.status,
          provider: req.body.provider ?? defaultProvider,
          providerConfigId: req.body.providerConfigId,
          managedMode: req.body.managedMode,
          providerMetadata: req.body.providerMetadata,
          usageGuidance: req.body.usageGuidance,
        },
        { userId: req.actor.userId ?? "board", agentId: null },
      );

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "user_secret_definition.created",
        entityType: "user_secret_definition",
        entityId: created.id,
        details: { key: created.key, provider: created.provider },
      });

      res.status(201).json(created);
    },
  );

  router.patch(
    "/companies/:companyId/user-secret-definitions/:definitionId",
    validate(updateUserSecretDefinitionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const definitionId = req.params.definitionId as string;
      assertSecretDefinitionAdmin(req, companyId);

      const updated = await svc.updateUserSecretDefinition(
        companyId,
        definitionId,
        {
          key: req.body.key,
          name: req.body.name,
          description: req.body.description,
          status: req.body.status,
          providerConfigId: req.body.providerConfigId,
          providerMetadata: req.body.providerMetadata,
          usageGuidance: req.body.usageGuidance,
        },
        { userId: req.actor.userId ?? "board", agentId: null },
      );
      if (!updated) {
        res.status(404).json({ error: "User secret definition not found" });
        return;
      }

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "user_secret_definition.updated",
        entityType: "user_secret_definition",
        entityId: updated.id,
        details: { key: updated.key, status: updated.status },
      });

      res.json(updated);
    },
  );

  router.delete("/companies/:companyId/user-secret-definitions/:definitionId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const definitionId = req.params.definitionId as string;
    assertSecretDefinitionAdmin(req, companyId);

    const removed = await svc.removeUserSecretDefinition(
      companyId,
      definitionId,
      { userId: req.actor.userId ?? "board", agentId: null },
    );
    if (!removed) {
      res.status(404).json({ error: "User secret definition not found" });
      return;
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "user_secret_definition.deleted",
      entityType: "user_secret_definition",
      entityId: removed.id,
      details: { key: removed.key },
    });

    res.json({ ok: true });
  });

  router.get("/companies/:companyId/user-secret-definitions/:definitionId/coverage", async (req, res) => {
    const companyId = req.params.companyId as string;
    const definitionId = req.params.definitionId as string;
    assertSecretDefinitionAdmin(req, companyId);
    res.json(await svc.getUserSecretDefinitionCoverage(companyId, definitionId));
  });

  router.get("/companies/:companyId/me/user-secrets", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listCurrentUserSecretValues(companyId, currentUserId(req)));
  });

  router.post(
    "/companies/:companyId/me/user-secrets",
    validate(createUserSecretValueSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const ownerUserId = currentUserId(req);
      const created = await svc.createCurrentUserSecretValue(
        companyId,
        ownerUserId,
        {
          definitionKey: req.body.definitionKey,
          definitionId: req.body.definitionId,
          value: req.body.value,
          externalRef: req.body.externalRef,
          providerVersionRef: req.body.providerVersionRef,
          providerConfigId: req.body.providerConfigId,
        },
        { userId: ownerUserId, agentId: null },
      );

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: ownerUserId,
        action: "user_secret_value.created",
        entityType: "secret",
        entityId: created.id,
        details: {
          userSecretDefinitionId: created.userSecretDefinitionId,
          ownerUserId: created.ownerUserId,
          provider: created.provider,
        },
      });

      res.status(201).json(created);
    },
  );

  router.patch(
    "/companies/:companyId/me/user-secrets/:secretId",
    validate(updateUserSecretValueSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const secretId = req.params.secretId as string;
      assertCompanyAccess(req, companyId);
      const ownerUserId = currentUserId(req);
      const updated = await svc.updateCurrentUserSecretValue(
        companyId,
        ownerUserId,
        secretId,
        {
          status: req.body.status,
          value: req.body.value,
          externalRef: req.body.externalRef,
          providerVersionRef: req.body.providerVersionRef,
          providerConfigId: req.body.providerConfigId,
        },
        { userId: ownerUserId, agentId: null },
      );
      if (!updated) {
        res.status(404).json({ error: "User secret value not found" });
        return;
      }

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: ownerUserId,
        action: "user_secret_value.updated",
        entityType: "secret",
        entityId: updated.id,
        details: {
          userSecretDefinitionId: updated.userSecretDefinitionId,
          ownerUserId: updated.ownerUserId,
          status: updated.status,
        },
      });

      res.json(updated);
    },
  );

  router.post(
    "/companies/:companyId/me/user-secrets/:secretId/rotate",
    validate(rotateUserSecretValueSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const secretId = req.params.secretId as string;
      assertCompanyAccess(req, companyId);
      const ownerUserId = currentUserId(req);
      const rotated = await svc.rotateCurrentUserSecretValue(
        companyId,
        ownerUserId,
        secretId,
        {
          value: req.body.value,
          externalRef: req.body.externalRef,
          providerVersionRef: req.body.providerVersionRef,
          providerConfigId: req.body.providerConfigId,
        },
        { userId: ownerUserId, agentId: null },
      );

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: ownerUserId,
        action: "user_secret_value.rotated",
        entityType: "secret",
        entityId: rotated.id,
        details: {
          userSecretDefinitionId: rotated.userSecretDefinitionId,
          ownerUserId: rotated.ownerUserId,
          version: rotated.latestVersion,
        },
      });

      res.json(rotated);
    },
  );

  router.delete("/companies/:companyId/me/user-secrets/:secretId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    const secretId = req.params.secretId as string;
    assertCompanyAccess(req, companyId);
    const ownerUserId = currentUserId(req);
    const removed = await svc.removeCurrentUserSecretValue(companyId, ownerUserId, secretId);
    if (!removed) {
      res.status(404).json({ error: "User secret value not found" });
      return;
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: ownerUserId,
      action: "user_secret_value.deleted",
      entityType: "secret",
      entityId: removed.id,
      details: {
        userSecretDefinitionId: removed.userSecretDefinitionId,
        ownerUserId: removed.ownerUserId,
      },
    });

    res.json({ ok: true });
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
    if (!isCompanyScopedSecret(existing)) {
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
    if (!isCompanyScopedSecret(existing)) {
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
    if (!isCompanyScopedSecret(existing)) {
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
    if (!isCompanyScopedSecret(existing)) {
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
    if (!isCompanyScopedSecret(existing)) {
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
