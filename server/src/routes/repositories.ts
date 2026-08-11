import { eq } from "drizzle-orm";
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { agents, projects } from "@paperclipai/db";
import {
  attachProjectRepositorySchema,
  beginRepositoryConnectionSchema,
  completeRepositoryConnectionSchema,
  createManualRepositorySchema,
  createRepositoryConnectionSchema,
  grantAgentRepositorySchema,
  importRepositoriesSchema,
  updateRepositorySchema,
  type RepositoryDiscoveryItem,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  logActivity,
  repositoryAccessService,
  repositoryConnectionService,
  repositoryService,
} from "../services/index.js";
import { getRepositoryProviderConnector } from "../services/repository-providers/registry.js";
import { forbidden, unprocessable } from "../errors.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

function activityActor(req: Request) {
  const actor = getActorInfo(req);
  return {
    actor,
    attribution: {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
    },
  };
}

export function repositoryRoutes(db: Db) {
  const router = Router();
  const repositories = repositoryService(db);
  const connections = repositoryConnectionService(db);
  const repositoryAccess = repositoryAccessService(db);
  const access = accessService(db);

  router.get("/companies/:companyId/repositories", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await repositories.list(companyId, { includeArchived: req.query.includeArchived === "true" }));
  });

  router.post(
    "/companies/:companyId/repositories",
    validate(createManualRepositorySchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await repositories.createManual(companyId, req.body);
      const { attribution } = activityActor(req);
      if (result.created) {
        await logActivity(db, {
          companyId,
          ...attribution,
          action: "repository.created",
          entityType: "repository",
          entityId: result.repository.id,
          details: {
            provider: result.repository.provider,
            host: result.repository.host,
            owner: result.repository.owner,
            name: result.repository.name,
          },
        });
      }
      res.status(result.created ? 201 : 200).json(result.repository);
    },
  );

  router.get("/repositories/:repositoryId", async (req, res) => {
    assertBoard(req);
    const repository = await getAccessibleResource(
      req,
      res,
      repositories.getById(req.params.repositoryId as string),
      "Repository not found",
    );
    if (!repository) return;
    res.json(repository);
  });

  router.patch("/repositories/:repositoryId", validate(updateRepositorySchema), async (req, res) => {
    assertBoard(req);
    const repositoryId = req.params.repositoryId as string;
    const existing = await getAccessibleResource(req, res, repositories.getById(repositoryId), "Repository not found");
    if (!existing) return;
    const updated = await repositories.update(existing.companyId, repositoryId, req.body);
    if (!updated) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }
    const { attribution } = activityActor(req);
    await logActivity(db, {
      companyId: existing.companyId,
      ...attribution,
      action: "repository.updated",
      entityType: "repository",
      entityId: repositoryId,
      details: { changedKeys: Object.keys(req.body).sort() },
    });
    res.json(updated);
  });

  router.delete("/repositories/:repositoryId", async (req, res) => {
    assertBoard(req);
    const repositoryId = req.params.repositoryId as string;
    const existing = await getAccessibleResource(req, res, repositories.getById(repositoryId), "Repository not found");
    if (!existing) return;
    const archived = await repositories.archive(existing.companyId, repositoryId);
    const { attribution } = activityActor(req);
    await logActivity(db, {
      companyId: existing.companyId,
      ...attribution,
      action: "repository.archived",
      entityType: "repository",
      entityId: repositoryId,
      details: { retainedRelationships: true },
    });
    res.json(archived);
  });

  router.get("/companies/:companyId/repository-connections", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await connections.list(companyId));
  });

  router.post(
    "/companies/:companyId/repository-connections",
    validate(createRepositoryConnectionSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await connections.create(companyId, req.body);
      const { attribution } = activityActor(req);
      if (result.created) {
        await logActivity(db, {
          companyId,
          ...attribution,
          action: "repository_connection.created",
          entityType: "repository_connection",
          entityId: result.connection.id,
          details: { provider: result.connection.provider, host: result.connection.host },
        });
      }
      res.status(result.created ? 201 : 200).json(result.connection);
    },
  );

  router.get("/repository-connections/:connectionId", async (req, res) => {
    assertBoard(req);
    const connection = await getAccessibleResource(
      req,
      res,
      connections.getById(req.params.connectionId as string),
      "Repository connection not found",
    );
    if (!connection) return;
    res.json(connection);
  });

  router.post("/repository-connections/:connectionId/sync", async (req, res) => {
    assertBoard(req);
    const connectionId = req.params.connectionId as string;
    const existing = await getAccessibleResource(
      req,
      res,
      connections.getById(connectionId),
      "Repository connection not found",
    );
    if (!existing) return;
    const { attribution } = activityActor(req);
    try {
      const result = await connections.sync(existing.companyId, connectionId);
      await logActivity(db, {
        companyId: existing.companyId,
        ...attribution,
        action: "repository_connection.synced",
        entityType: "repository_connection",
        entityId: connectionId,
        details: { repositoryCount: result?.repositories.length ?? 0 },
      });
      res.json(result);
    } catch (error) {
      await logActivity(db, {
        companyId: existing.companyId,
        ...attribution,
        action: "repository_connection.sync_failed",
        entityType: "repository_connection",
        entityId: connectionId,
        details: { provider: existing.provider, status: "failed" },
      });
      throw error;
    }
  });

  router.delete("/repository-connections/:connectionId", async (req, res) => {
    assertBoard(req);
    const connectionId = req.params.connectionId as string;
    const existing = await getAccessibleResource(
      req,
      res,
      connections.getById(connectionId),
      "Repository connection not found",
    );
    if (!existing) return;
    const { attribution } = activityActor(req);
    try {
      const result = await connections.disconnect(existing.companyId, connectionId);
      await logActivity(db, {
        companyId: existing.companyId,
        ...attribution,
        action: "repository_connection.disconnected",
        entityType: "repository_connection",
        entityId: connectionId,
        details: { unavailableRepositoryCount: result?.repositories.length ?? 0 },
      });
      res.json(result);
    } catch (error) {
      await logActivity(db, {
        companyId: existing.companyId,
        ...attribution,
        action: "repository_connection.disconnect_failed",
        entityType: "repository_connection",
        entityId: connectionId,
        details: { provider: existing.provider, status: "failed" },
      });
      throw error;
    }
  });

  // ---- Provider connection flow (GitHub.com + other discovery providers) ----

  router.post(
    "/companies/:companyId/repository-connections/:provider/install",
    validate(beginRepositoryConnectionSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const providerKey = (req.params.provider as string).toLowerCase();
      const connector = getRepositoryProviderConnector(providerKey);
      if (!connector) throw unprocessable(`Repository provider '${providerKey}' is not available`);
      const { actor } = activityActor(req);
      const userId = actor.actorType === "user" ? actor.actorId : actor.agentId;
      if (!userId) throw forbidden("A user or agent identity is required to begin a connection");
      const begin = await connector.beginInstallation({
        companyId,
        userId,
        redirectPath: req.body.redirectPath ?? null,
      });
      res.status(201).json({
        provider: connector.provider,
        installUrl: begin.installUrl,
        state: begin.state,
        expiresAt: begin.expiresAt.toISOString(),
      });
    },
  );

  router.post(
    "/companies/:companyId/repository-connections/:provider/callback",
    validate(completeRepositoryConnectionSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const providerKey = (req.params.provider as string).toLowerCase();
      const connector = getRepositoryProviderConnector(providerKey);
      if (!connector) throw unprocessable(`Repository provider '${providerKey}' is not available`);
      const meta = await connector.completeInstallation({
        state: req.body.state,
        installationId: req.body.installationId,
        companyId,
      });
      // Create the connection only. Repositories are imported explicitly via
      // the multi-select import flow so nothing is silently attached.
      const result = await connections.create(companyId, {
        provider: connector.provider,
        host: meta.host,
        installationId: meta.installationId,
        accountId: meta.accountId,
        accountName: meta.accountName,
      });
      const { attribution } = activityActor(req);
      if (result.created) {
        await logActivity(db, {
          companyId,
          ...attribution,
          action: "repository_connection.created",
          entityType: "repository_connection",
          entityId: result.connection.id,
          details: { provider: result.connection.provider, host: result.connection.host, via: "callback" },
        });
      }
      res
        .status(result.created ? 201 : 200)
        .json({ connection: result.connection, created: result.created, repositories: [] });
    },
  );

  router.get("/repository-connections/:connectionId/discover", async (req, res) => {
    assertBoard(req);
    const connectionId = req.params.connectionId as string;
    const connection = await getAccessibleResource(
      req,
      res,
      connections.getById(connectionId),
      "Repository connection not found",
    );
    if (!connection) return;
    const connector = getRepositoryProviderConnector(connection.provider);
    if (!connector) throw unprocessable(`Repository provider '${connection.provider}' does not support discovery`);
    if (connection.status === "disconnected") throw unprocessable("Disconnected repository connection cannot be discovered");

    const pageSizeRaw = Number.parseInt(String(req.query.pageSize ?? ""), 10);
    const page = await connector.discover({
      connection,
      query: typeof req.query.query === "string" ? req.query.query : null,
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : null,
      pageSize: Number.isFinite(pageSizeRaw) ? pageSizeRaw : undefined,
    });
    const imported = await repositories.findImportedProviderRepositories(
      connection.companyId,
      connectionId,
      page.items.map((item) => item.providerRepositoryId),
    );
    const importedById = new Map(imported.map((repo) => [repo.providerRepositoryId, repo]));
    const items: RepositoryDiscoveryItem[] = page.items.map((item) => {
      const existing = importedById.get(item.providerRepositoryId);
      return {
        providerRepositoryId: item.providerRepositoryId,
        owner: item.owner,
        name: item.name,
        cloneUrl: item.cloneUrl,
        webUrl: item.webUrl ?? null,
        defaultBranch: item.defaultBranch ?? null,
        visibility: item.visibility ?? "unknown",
        archived: item.archived ?? false,
        imported: Boolean(existing),
        importedRepositoryId: existing?.id ?? null,
        metadata: item.metadata ?? null,
      };
    });
    res.json({ connectionId, items, nextCursor: page.nextCursor, total: page.total });
  });

  router.post(
    "/repository-connections/:connectionId/import",
    validate(importRepositoriesSchema),
    async (req, res) => {
      assertBoard(req);
      const connectionId = req.params.connectionId as string;
      const connection = await getAccessibleResource(
        req,
        res,
        connections.getById(connectionId),
        "Repository connection not found",
      );
      if (!connection) return;
      const connector = getRepositoryProviderConnector(connection.provider);
      if (!connector) throw unprocessable(`Repository provider '${connection.provider}' does not support import`);
      if (connection.status === "disconnected") throw unprocessable("Disconnected repository connection cannot import repositories");

      const providerRepositoryIds: string[] = req.body.providerRepositoryIds;
      const importedRepositories = [];
      const skipped: string[] = [];
      for (const providerRepositoryId of providerRepositoryIds) {
        const snapshot = await connector.refreshMetadata({ connection, providerRepositoryId });
        if (!snapshot) {
          skipped.push(providerRepositoryId);
          continue;
        }
        importedRepositories.push(
          await repositories.upsertProviderRepository(connection.companyId, connectionId, connection.provider, snapshot),
        );
      }
      const { attribution } = activityActor(req);
      if (importedRepositories.length > 0) {
        await logActivity(db, {
          companyId: connection.companyId,
          ...attribution,
          action: "repository.imported",
          entityType: "repository_connection",
          entityId: connectionId,
          details: {
            provider: connection.provider,
            importedCount: importedRepositories.length,
            skippedCount: skipped.length,
          },
        });
      }
      res
        .status(importedRepositories.length > 0 ? 201 : 200)
        .json({ repositories: importedRepositories, imported: importedRepositories.length, skipped });
    },
  );

  router.post("/repositories/:repositoryId/clone-credential", async (req, res) => {
    const repositoryId = req.params.repositoryId as string;
    const repository = await getAccessibleResource(
      req,
      res,
      repositories.getById(repositoryId),
      "Repository not found",
    );
    if (!repository) return;
    if (repository.state !== "active") throw unprocessable("Archived or unavailable repository cannot resolve clone credentials");
    if (!repository.connectionId) throw unprocessable("Repository is not backed by a provider connection");

    // Authorize through the effective-access resolver: company/board actors are
    // allowed within their company; agents must hold effective access (a direct
    // grant or an accessible project source) to the repository.
    const reqActor = req.actor;
    let authorized = false;
    if (reqActor.type === "board") {
      authorized = reqActor.isInstanceAdmin === true || (reqActor.companyIds?.includes(repository.companyId) ?? false);
    } else if (reqActor.type === "agent" && reqActor.agentId) {
      const effective = await repositoryAccess.listEffectiveRepositories({
        companyId: repository.companyId,
        agentId: reqActor.agentId,
        canAccessProject: async (project) => (await access.decide({
          actor: reqActor,
          action: "project:read",
          resource: { type: "project", companyId: project.companyId, projectId: project.id },
        })).allowed,
      });
      authorized = (effective ?? []).some((entry) => entry.repository.id === repository.id);
    }
    if (!authorized) throw forbidden("Repository is outside this actor's effective access");

    const connection = await connections.getById(repository.connectionId);
    if (!connection || connection.status === "disconnected") throw unprocessable("Repository connection is unavailable");
    const connector = getRepositoryProviderConnector(connection.provider);
    if (!connector) throw unprocessable(`Repository provider '${connection.provider}' cannot resolve clone credentials`);

    const resolved = await connector.resolveCloneCredential({
      connection,
      repository: {
        id: repository.id,
        providerRepositoryId: repository.providerRepositoryId,
        owner: repository.owner,
        name: repository.name,
        host: repository.host,
        cloneUrl: repository.cloneUrl,
      },
    });
    const { attribution } = activityActor(req);
    await logActivity(db, {
      companyId: repository.companyId,
      ...attribution,
      action: "repository.clone_credential_resolved",
      entityType: "repository",
      entityId: repository.id,
      details: {
        provider: resolved.audit.provider,
        host: resolved.audit.host,
        connectionId: resolved.audit.connectionId,
        installationId: resolved.audit.installationId,
        expiresAt: resolved.audit.expiresAt.toISOString(),
      },
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      username: resolved.username,
      token: resolved.token,
      authenticatedCloneUrl: resolved.authenticatedCloneUrl,
      expiresAt: resolved.expiresAt.toISOString(),
    });
  });

  router.get("/projects/:projectId/repositories", async (req, res) => {
    const projectId = req.params.projectId as string;
    const project = await getAccessibleResource(
      req,
      res,
      db.select({ id: projects.id, companyId: projects.companyId }).from(projects).where(eq(projects.id, projectId)).then((rows) => rows[0] ?? null),
      "Project not found",
    );
    if (!project) return;
    const decision = await access.decide({
      actor: req.actor,
      action: "project:read",
      resource: { type: "project", companyId: project.companyId, projectId },
    });
    if (!decision.allowed) {
      res.status(403).json({ error: "Project is outside this actor's authorization boundary" });
      return;
    }
    res.json(await repositoryAccess.listProjectRepositories(project.companyId, projectId));
  });

  router.put(
    "/projects/:projectId/repositories/:repositoryId",
    validate(attachProjectRepositorySchema),
    async (req, res) => {
      assertBoard(req);
      const projectId = req.params.projectId as string;
      const repositoryId = req.params.repositoryId as string;
      const project = await getAccessibleResource(
        req,
        res,
        db.select({ id: projects.id, companyId: projects.companyId }).from(projects).where(eq(projects.id, projectId)).then((rows) => rows[0] ?? null),
        "Project not found",
      );
      if (!project) return;
      const { actor, attribution } = activityActor(req);
      const result = await repositoryAccess.attachProjectRepository({
        companyId: project.companyId,
        projectId,
        repositoryId,
        displayOrder: req.body.displayOrder,
        createdByAgentId: actor.actorType === "agent" ? actor.agentId : null,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      if (!result) {
        res.status(404).json({ error: "Repository not found" });
        return;
      }
      if (result.created) {
        await logActivity(db, {
          companyId: project.companyId,
          ...attribution,
          action: "project_repository.attached",
          entityType: "project_repository",
          entityId: result.entry.link.id,
          details: { projectId, repositoryId },
        });
      }
      res.status(result.created ? 201 : 200).json(result.entry);
    },
  );

  router.delete("/projects/:projectId/repositories/:repositoryId", async (req, res) => {
    assertBoard(req);
    const projectId = req.params.projectId as string;
    const repositoryId = req.params.repositoryId as string;
    const project = await getAccessibleResource(
      req,
      res,
      db.select({ id: projects.id, companyId: projects.companyId }).from(projects).where(eq(projects.id, projectId)).then((rows) => rows[0] ?? null),
      "Project not found",
    );
    if (!project) return;
    const result = await repositoryAccess.detachProjectRepository(project.companyId, projectId, repositoryId);
    if (!result) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }
    if (result.removed) {
      const { attribution } = activityActor(req);
      await logActivity(db, {
        companyId: project.companyId,
        ...attribution,
        action: "project_repository.detached",
        entityType: "project_repository",
        entityId: result.link!.id,
        details: { projectId, repositoryId },
      });
    }
    res.json({ removed: result.removed });
  });

  router.get("/agents/:agentId/repositories", async (req, res) => {
    const agentId = req.params.agentId as string;
    const agent = await getAccessibleResource(
      req,
      res,
      db.select({ id: agents.id, companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null),
      "Agent not found",
    );
    if (!agent) return;
    const decision = await access.decide({
      actor: req.actor,
      action: "agent:read",
      resource: { type: "agent", companyId: agent.companyId, agentId },
    });
    if (!decision.allowed) {
      res.status(403).json({ error: "Agent is outside this actor's authorization boundary" });
      return;
    }
    if (req.query.effective !== "true") {
      res.json(await repositoryAccess.listDirectGrants(agent.companyId, agentId));
      return;
    }

    const projectAuthorizationActor = req.actor.type === "agent" && req.actor.agentId === agentId
      ? req.actor
      : { type: "agent" as const, agentId, companyId: agent.companyId, source: "agent_key" as const };
    const result = await repositoryAccess.listEffectiveRepositories({
      companyId: agent.companyId,
      agentId,
      canAccessProject: async (project) => (await access.decide({
        actor: projectAuthorizationActor,
        action: "project:read",
        resource: { type: "project", companyId: project.companyId, projectId: project.id },
      })).allowed,
    });
    res.json(result);
  });

  router.put(
    "/agents/:agentId/repositories/:repositoryId",
    validate(grantAgentRepositorySchema),
    async (req, res) => {
      assertBoard(req);
      const agentId = req.params.agentId as string;
      const repositoryId = req.params.repositoryId as string;
      const agent = await getAccessibleResource(
        req,
        res,
        db.select({ id: agents.id, companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null),
        "Agent not found",
      );
      if (!agent) return;
      const { actor, attribution } = activityActor(req);
      const result = await repositoryAccess.grantAgentRepository({
        companyId: agent.companyId,
        agentId,
        repositoryId,
        grantedByAgentId: actor.actorType === "agent" ? actor.agentId : null,
        grantedByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      if (!result) {
        res.status(404).json({ error: "Repository not found" });
        return;
      }
      if (result.created) {
        await logActivity(db, {
          companyId: agent.companyId,
          ...attribution,
          action: "agent_repository.granted",
          entityType: "agent_repository_grant",
          entityId: result.entry.grant.id,
          details: { agentId, repositoryId },
        });
      }
      res.status(result.created ? 201 : 200).json(result.entry);
    },
  );

  router.delete("/agents/:agentId/repositories/:repositoryId", async (req, res) => {
    assertBoard(req);
    const agentId = req.params.agentId as string;
    const repositoryId = req.params.repositoryId as string;
    const agent = await getAccessibleResource(
      req,
      res,
      db.select({ id: agents.id, companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null),
      "Agent not found",
    );
    if (!agent) return;
    const result = await repositoryAccess.revokeAgentRepository(agent.companyId, agentId, repositoryId);
    if (!result) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }
    if (result.removed) {
      const { attribution } = activityActor(req);
      await logActivity(db, {
        companyId: agent.companyId,
        ...attribution,
        action: "agent_repository.revoked",
        entityType: "agent_repository_grant",
        entityId: result.grant!.id,
        details: { agentId, repositoryId },
      });
    }
    res.json({ removed: result.removed });
  });

  return router;
}
