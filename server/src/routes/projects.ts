import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createProjectSchema,
  createProjectWorkspaceSchema,
  isUuidLike,
  updateProjectSchema,
  updateProjectWorkspaceSchema,
  addProjectMemberSchema,
  updateProjectMemberPermissionsSchema,
  addProjectAgentSchema,
  applyProjectRolePresetSchema,
  PROJECT_ROLE_PRESETS,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { projectService, accessService, logActivity } from "../services/index.js";
import { conflict, forbidden, notFound } from "../errors.js";
import { assertCompanyAccess, getActorInfo, requireProjectPermission, requireProjectAccess } from "./authz.js";

export function projectRoutes(db: Db) {
  const router = Router();
  const svc = projectService(db);
  const access = accessService(db);

  async function resolveCompanyIdForProjectReference(req: Request) {
    const companyIdQuery = req.query.companyId;
    const requestedCompanyId =
      typeof companyIdQuery === "string" && companyIdQuery.trim().length > 0
        ? companyIdQuery.trim()
        : null;
    if (requestedCompanyId) {
      assertCompanyAccess(req, requestedCompanyId);
      return requestedCompanyId;
    }
    if (req.actor.type === "agent" && req.actor.companyId) {
      return req.actor.companyId;
    }
    return null;
  }

  async function normalizeProjectReference(req: Request, rawId: string) {
    if (isUuidLike(rawId)) return rawId;
    const companyId = await resolveCompanyIdForProjectReference(req);
    if (!companyId) return rawId;
    const resolved = await svc.resolveByReference(companyId, rawId);
    if (resolved.ambiguous) {
      throw conflict("Project shortname is ambiguous in this company. Use the project ID.");
    }
    return resolved.project?.id ?? rawId;
  }

  router.param("id", async (req, _res, next, rawId) => {
    try {
      req.params.id = await normalizeProjectReference(req, rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/projects", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const includeArchived = req.query.includeArchived === "true";
    const archivedOnly = req.query.archived === "true";
    let result = await svc.list(companyId, { includeArchived, archivedOnly });

    const actor = getActorInfo(req);
    if (actor.actorType === "user") {
      const accessibleIds = await access.listAccessibleProjects(companyId, actor.actorId);
      // Empty array means "owner, show all"
      if (accessibleIds.length > 0) {
        result = result.filter((p: any) => accessibleIds.includes(p.id));
      }
    }

    res.json(result);
  });

  router.get("/projects/:id", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);
    res.json(project);
  });

  router.post("/companies/:companyId/projects", validate(createProjectSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
        const allowed = await access.canUser(companyId, req.actor.userId, "projects:manage");
        if (!allowed) throw forbidden("Missing permission: projects:manage");
      }
    }
    type CreateProjectPayload = Parameters<typeof svc.create>[1] & {
      workspace?: Parameters<typeof svc.createWorkspace>[1];
    };

    const { workspace, ...projectData } = req.body as CreateProjectPayload;
    const project = await svc.create(companyId, projectData);
    let createdWorkspaceId: string | null = null;
    if (workspace) {
      const createdWorkspace = await svc.createWorkspace(project.id, workspace);
      if (!createdWorkspace) {
        await svc.remove(project.id);
        res.status(422).json({ error: "Invalid project workspace payload" });
        return;
      }
      createdWorkspaceId = createdWorkspace.id;
    }
    const hydratedProject = workspace ? await svc.getById(project.id) : project;

    const actor = getActorInfo(req);

    // Auto-add creator as project super_admin
    if (actor.actorType === "user") {
      await access.addProjectMember(
        project.id,
        companyId,
        "user",
        actor.actorId,
        "super_admin",
        actor.actorId,
      );
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.created",
      entityType: "project",
      entityId: project.id,
      details: {
        name: project.name,
        workspaceId: createdWorkspaceId,
      },
    });
    res.status(201).json(hydratedProject ?? project);
  });

  router.patch("/projects/:id", validate(updateProjectSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await requireProjectPermission(req, access, existing.companyId, existing.id, "project:settings");
    const project = await svc.update(id, req.body);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.updated",
      entityType: "project",
      entityId: project.id,
      details: req.body,
    });

    res.json(project);
  });

  router.get("/projects/:id/workspaces", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const workspaces = await svc.listWorkspaces(id);
    res.json(workspaces);
  });

  router.post("/projects/:id/workspaces", validate(createProjectWorkspaceSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (req.actor.type === "board") {
      if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
        const allowed = await access.canUser(existing.companyId, req.actor.userId, "projects:manage");
        if (!allowed) throw forbidden("Missing permission: projects:manage");
      }
    }
    const workspace = await svc.createWorkspace(id, req.body);
    if (!workspace) {
      res.status(422).json({ error: "Invalid project workspace payload" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.workspace_created",
      entityType: "project",
      entityId: id,
      details: {
        workspaceId: workspace.id,
        name: workspace.name,
        cwd: workspace.cwd,
        isPrimary: workspace.isPrimary,
      },
    });

    res.status(201).json(workspace);
  });

  router.patch(
    "/projects/:id/workspaces/:workspaceId",
    validate(updateProjectWorkspaceSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const workspaceId = req.params.workspaceId as string;
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);
      if (req.actor.type === "board") {
        if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
          const allowed = await access.canUser(existing.companyId, req.actor.userId, "projects:manage");
          if (!allowed) throw forbidden("Missing permission: projects:manage");
        }
      }
      const workspaceExists = (await svc.listWorkspaces(id)).some((workspace) => workspace.id === workspaceId);
      if (!workspaceExists) {
        res.status(404).json({ error: "Project workspace not found" });
        return;
      }
      const workspace = await svc.updateWorkspace(id, workspaceId, req.body);
      if (!workspace) {
        res.status(422).json({ error: "Invalid project workspace payload" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "project.workspace_updated",
        entityType: "project",
        entityId: id,
        details: {
          workspaceId: workspace.id,
          changedKeys: Object.keys(req.body).sort(),
        },
      });

      res.json(workspace);
    },
  );

  router.delete("/projects/:id/workspaces/:workspaceId", async (req, res) => {
    const id = req.params.id as string;
    const workspaceId = req.params.workspaceId as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (req.actor.type === "board") {
      if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
        const allowed = await access.canUser(existing.companyId, req.actor.userId, "projects:manage");
        if (!allowed) throw forbidden("Missing permission: projects:manage");
      }
    }
    const workspace = await svc.removeWorkspace(id, workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "Project workspace not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.workspace_deleted",
      entityType: "project",
      entityId: id,
      details: {
        workspaceId: workspace.id,
        name: workspace.name,
      },
    });

    res.json(workspace);
  });

  router.post("/projects/:id/archive", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (req.actor.type === "board") {
      if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
        const allowed = await access.canUser(existing.companyId, req.actor.userId, "projects:manage");
        if (!allowed) throw forbidden("Missing permission: projects:manage");
      }
    }
    if (existing.archivedAt) {
      res.json(existing);
      return;
    }
    const project = await svc.archive(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.archived",
      entityType: "project",
      entityId: project.id,
      details: { name: project.name },
    });

    res.json(project);
  });

  router.post("/projects/:id/unarchive", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (req.actor.type === "board") {
      if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
        const allowed = await access.canUser(existing.companyId, req.actor.userId, "projects:manage");
        if (!allowed) throw forbidden("Missing permission: projects:manage");
      }
    }
    if (!existing.archivedAt) {
      res.json(existing);
      return;
    }
    const project = await svc.unarchive(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.unarchived",
      entityType: "project",
      entityId: project.id,
      details: { name: project.name },
    });

    res.json(project);
  });

  router.delete("/projects/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (req.actor.type === "board") {
      if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
        const allowed = await access.canUser(existing.companyId, req.actor.userId, "projects:manage");
        if (!allowed) throw forbidden("Missing permission: projects:manage");
      }
    }
    const project = await svc.remove(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.deleted",
      entityType: "project",
      entityId: project.id,
    });

    res.json(project);
  });

  // --- Project Members ---

  // List project members
  router.get("/projects/:id/members", async (req, res) => {
    const projectId = req.params.id as string;
    const project = await svc.getById(projectId);
    if (!project) throw notFound("Project not found");
    await requireProjectAccess(req, access, project.companyId, projectId);
    const members = await access.listProjectMembers(projectId);
    res.json(members);
  });

  // Add project member
  router.post("/projects/:id/members", validate(addProjectMemberSchema), async (req, res) => {
    const projectId = req.params.id as string;
    const project = await svc.getById(projectId);
    if (!project) throw notFound("Project not found");
    await requireProjectPermission(req, access, project.companyId, projectId, "project:members:manage");
    const member = await access.addProjectMember(
      projectId,
      project.companyId,
      req.body.principalType,
      req.body.principalId,
      req.body.role,
      req.actor?.userId ?? null,
    );
    res.status(201).json(member);
  });

  // Update project member permissions (fine-tune)
  router.patch(
    "/projects/:id/members/:memberId/permissions",
    validate(updateProjectMemberPermissionsSchema),
    async (req, res) => {
      const projectId = req.params.id as string;
      const memberId = req.params.memberId as string;
      const project = await svc.getById(projectId);
      if (!project) throw notFound("Project not found");
      await requireProjectPermission(req, access, project.companyId, projectId, "project:members:manage");
      const updated = await access.setProjectMemberPermissions(
        projectId,
        memberId,
        req.body.grants,
        req.actor?.userId ?? null,
      );
      if (!updated) throw notFound("Member not found");
      res.json(updated);
    },
  );

  // Apply role preset to project member
  router.post(
    "/projects/:id/members/:memberId/role-preset",
    validate(applyProjectRolePresetSchema),
    async (req, res) => {
      const projectId = req.params.id as string;
      const memberId = req.params.memberId as string;
      const project = await svc.getById(projectId);
      if (!project) throw notFound("Project not found");
      await requireProjectPermission(req, access, project.companyId, projectId, "project:members:manage");
      const preset = PROJECT_ROLE_PRESETS.find((p) => p.id === req.body.presetId);
      if (!preset) throw notFound("Preset not found");
      const updated = await access.setProjectMemberPermissions(
        projectId,
        memberId,
        preset.permissions.map((key) => ({ permissionKey: key })),
        req.actor?.userId ?? null,
      );
      if (!updated) throw notFound("Member not found");
      res.json({ ...updated, appliedPreset: req.body.presetId });
    },
  );

  // Remove project member
  router.delete("/projects/:id/members/:memberId", async (req, res) => {
    const projectId = req.params.id as string;
    const memberId = req.params.memberId as string;
    const project = await svc.getById(projectId);
    if (!project) throw notFound("Project not found");
    await requireProjectPermission(req, access, project.companyId, projectId, "project:members:manage");
    const removed = await access.removeProjectMember(projectId, memberId);
    if (!removed) throw notFound("Member not found");
    res.json(removed);
  });

  // --- Project Agents ---

  // List project agents
  router.get("/projects/:id/agents-access", async (req, res) => {
    const projectId = req.params.id as string;
    const project = await svc.getById(projectId);
    if (!project) throw notFound("Project not found");
    await requireProjectAccess(req, access, project.companyId, projectId);
    const projectAgents = await access.listProjectAgents(projectId);
    res.json(projectAgents);
  });

  // Add agent to project
  router.post("/projects/:id/agents-access", validate(addProjectAgentSchema), async (req, res) => {
    const projectId = req.params.id as string;
    const project = await svc.getById(projectId);
    if (!project) throw notFound("Project not found");
    await requireProjectPermission(req, access, project.companyId, projectId, "project:members:manage");
    const row = await access.addProjectAgent(projectId, project.companyId, req.body.agentId, req.actor?.userId ?? null);
    res.status(201).json(row);
  });

  // Remove agent from project
  router.delete("/projects/:id/agents-access/:agentId", async (req, res) => {
    const projectId = req.params.id as string;
    const agentId = req.params.agentId as string;
    const project = await svc.getById(projectId);
    if (!project) throw notFound("Project not found");
    await requireProjectPermission(req, access, project.companyId, projectId, "project:members:manage");
    const removed = await access.removeProjectAgent(projectId, agentId);
    if (!removed) throw notFound("Agent not assigned to project");
    res.json(removed);
  });

  // Project role presets list
  router.get("/project-role-presets", (_req, res) => {
    res.json(PROJECT_ROLE_PRESETS);
  });

  return router;
}
