import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createTeamSchema,
  updateTeamSchema,
  addTeamMemberSchema,
  createWorkflowStatusSchema,
  updateWorkflowStatusSchema,
  upsertTeamDocumentSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  teamService,
  workflowStatusService,
  teamDocumentService,
  logActivity,
} from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function teamRoutes(db: Db) {
  const router = Router();
  const svc = teamService(db);
  const wfSvc = workflowStatusService(db);
  const docSvc = teamDocumentService(db);

  // --- Teams CRUD ---

  router.get("/companies/:companyId/teams", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId);
    res.json(result);
  });

  router.get("/companies/:companyId/teams/:teamId", async (req, res) => {
    const teamId = req.params.teamId as string;
    const team = await svc.getById(teamId);
    if (!team) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    assertCompanyAccess(req, team.companyId);
    res.json(team);
  });

  router.post("/companies/:companyId/teams", validate(createTeamSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const team = await svc.create(companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "team.created",
        entityType: "team",
        entityId: team.id,
        details: { name: team.name, identifier: team.identifier },
      });
      res.status(201).json(team);
    } catch (err: any) {
      if (err?.status === 409 || err?.status === 422 || err?.status === 404) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.patch("/companies/:companyId/teams/:teamId", validate(updateTeamSchema), async (req, res) => {
    const teamId = req.params.teamId as string;
    const existing = await svc.getById(teamId);
    if (!existing) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    try {
      const team = await svc.update(teamId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "team.updated",
        entityType: "team",
        entityId: teamId,
        details: { name: team?.name },
      });
      res.json(team);
    } catch (err: any) {
      if (err?.status === 422 || err?.status === 404) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.delete("/companies/:companyId/teams/:teamId", async (req, res) => {
    const teamId = req.params.teamId as string;
    const existing = await svc.getById(teamId);
    if (!existing) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const team = await svc.remove(teamId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "team.deleted",
      entityType: "team",
      entityId: teamId,
      details: { name: existing.name },
    });
    res.json(team);
  });

  // --- Team Members ---

  router.get("/companies/:companyId/teams/:teamId/members", async (req, res) => {
    const teamId = req.params.teamId as string;
    const team = await svc.getById(teamId);
    if (!team) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    assertCompanyAccess(req, team.companyId);
    const members = await svc.listMembers(teamId);
    res.json(members);
  });

  router.post("/companies/:companyId/teams/:teamId/members", validate(addTeamMemberSchema), async (req, res) => {
    const teamId = req.params.teamId as string;
    const team = await svc.getById(teamId);
    if (!team) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    assertCompanyAccess(req, team.companyId);
    try {
      const member = await svc.addMember(teamId, team.companyId, req.body);
      if (!member) {
        res.status(409).json({ error: "Member already exists in team" });
        return;
      }
      res.status(201).json(member);
    } catch (err: any) {
      if (err?.status === 422 || err?.status === 404) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.delete("/companies/:companyId/teams/:teamId/members/:memberId", async (req, res) => {
    const teamId = req.params.teamId as string;
    const memberId = req.params.memberId as string;
    const team = await svc.getById(teamId);
    if (!team) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    assertCompanyAccess(req, team.companyId);
    const removed = await svc.removeMember(teamId, memberId);
    if (!removed) {
      res.status(404).json({ error: "Member not found in this team" });
      return;
    }
    res.json(removed);
  });

  // --- Team instructions context (sub-agent list for leader) ---

  router.get("/companies/:companyId/teams/:teamId/instructions-context", async (req, res) => {
    const teamId = req.params.teamId as string;
    const team = await svc.getById(teamId);
    if (!team) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    assertCompanyAccess(req, team.companyId);

    const members = await svc.listMembers(teamId);
    const memberIdsToFetch = members
      .map((m) => m.agentId)
      .filter((id): id is string => id !== null);

    // Fetch agent details for each member
    const agentRows = await Promise.all(
      memberIdsToFetch.map(async (agentId) => {
        const { agentService } = await import("../services/agents.js");
        const a = await agentService(db).getById(agentId);
        return a;
      }),
    );

    const subAgents = agentRows
      .filter((a) => a !== null)
      // Defense in depth: only return agents that belong to the same company as the team
      .filter((a) => a!.companyId === team.companyId)
      .filter((a) => a!.adapterType !== "claude_local")
      .map((a) => ({
        id: a!.id,
        name: a!.name,
        title: a!.title,
        capabilities: a!.capabilities,
      }));

    // Build markdown snippet for instruction injection
    const lines: string[] = [];
    lines.push(`## ${team.name} Team Members`);
    lines.push("");
    lines.push("Sub-agents you can spawn via Agent tool to delegate work:");
    lines.push("");
    for (const a of subAgents) {
      const title = a.title ? ` (${a.title})` : "";
      const caps = a.capabilities ? `: ${a.capabilities}` : "";
      lines.push(`- **${a.name}**${title}${caps}`);
    }

    res.json({
      team: {
        id: team.id,
        name: team.name,
        identifier: team.identifier,
      },
      subAgents,
      markdown: lines.join("\n"),
    });
  });

  // --- Workflow statuses ---

  router.get("/companies/:companyId/teams/:teamId/workflow-statuses", async (req, res) => {
    const teamId = req.params.teamId as string;
    const team = await svc.getById(teamId);
    if (!team) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    assertCompanyAccess(req, team.companyId);
    const statuses = await wfSvc.list(teamId);
    res.json(statuses);
  });

  router.post(
    "/companies/:companyId/teams/:teamId/workflow-statuses",
    validate(createWorkflowStatusSchema),
    async (req, res) => {
      const teamId = req.params.teamId as string;
      const team = await svc.getById(teamId);
      if (!team) {
        res.status(404).json({ error: "Team not found" });
        return;
      }
      assertCompanyAccess(req, team.companyId);
      try {
        const status = await wfSvc.create(teamId, req.body);
        res.status(201).json(status);
      } catch (err: any) {
        if (err.status === 409) {
          res.status(409).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  router.patch(
    "/companies/:companyId/teams/:teamId/workflow-statuses/:statusId",
    validate(updateWorkflowStatusSchema),
    async (req, res) => {
      const statusId = req.params.statusId as string;
      const team = await svc.getById(req.params.teamId as string);
      if (!team) {
        res.status(404).json({ error: "Team not found" });
        return;
      }
      assertCompanyAccess(req, team.companyId);
      const updated = await wfSvc.update(statusId, req.body);
      if (!updated) {
        res.status(404).json({ error: "Workflow status not found" });
        return;
      }
      res.json(updated);
    },
  );

  router.delete(
    "/companies/:companyId/teams/:teamId/workflow-statuses/:statusId",
    async (req, res) => {
      const statusId = req.params.statusId as string;
      const team = await svc.getById(req.params.teamId as string);
      if (!team) {
        res.status(404).json({ error: "Team not found" });
        return;
      }
      assertCompanyAccess(req, team.companyId);
      try {
        const removed = await wfSvc.remove(statusId);
        if (!removed) {
          res.status(404).json({ error: "Workflow status not found" });
          return;
        }
        res.json(removed);
      } catch (err: any) {
        if (err.status === 400) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // === Team documents ===

  router.get("/companies/:companyId/teams/:teamId/documents", async (req, res) => {
    const team = await svc.getById(req.params.teamId as string);
    if (!team) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    assertCompanyAccess(req, team.companyId);
    res.json(await docSvc.list(team.id, team.companyId));
  });

  router.get(
    "/companies/:companyId/teams/:teamId/documents/:key",
    async (req, res) => {
      const team = await svc.getById(req.params.teamId as string);
      if (!team) {
        res.status(404).json({ error: "Team not found" });
        return;
      }
      assertCompanyAccess(req, team.companyId);
      const doc = await docSvc.getByKey(
        team.id,
        team.companyId,
        req.params.key as string,
      );
      if (!doc) {
        res.status(404).json({ error: "Document not found" });
        return;
      }
      res.json(doc);
    },
  );

  router.put(
    "/companies/:companyId/teams/:teamId/documents/:key",
    validate(upsertTeamDocumentSchema),
    async (req, res) => {
      const team = await svc.getById(req.params.teamId as string);
      if (!team) {
        res.status(404).json({ error: "Team not found" });
        return;
      }
      assertCompanyAccess(req, team.companyId);
      const actor = getActorInfo(req);
      try {
        // URL key takes precedence over body key so PUT is idempotent per URL.
        const body = { ...req.body, key: req.params.key as string };
        const result = await docSvc.upsert({
          teamId: team.id,
          companyId: team.companyId,
          ...body,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId:
            actor.actorType === "user" || actor.actorType === "board"
              ? actor.actorId
              : null,
        });
        res.status(result.created ? 201 : 200).json(result);
      } catch (err: any) {
        if (err?.status === 409 || err?.status === 422 || err?.status === 404) {
          res.status(err.status).json({ error: err.message, ...(err.details ?? {}) });
          return;
        }
        throw err;
      }
    },
  );

  router.delete(
    "/companies/:companyId/teams/:teamId/documents/:key",
    async (req, res) => {
      const team = await svc.getById(req.params.teamId as string);
      if (!team) {
        res.status(404).json({ error: "Team not found" });
        return;
      }
      assertCompanyAccess(req, team.companyId);
      const removed = await docSvc.remove(
        team.id,
        team.companyId,
        req.params.key as string,
      );
      if (!removed) {
        res.status(404).json({ error: "Document not found" });
        return;
      }
      res.json(removed);
    },
  );

  router.get(
    "/companies/:companyId/teams/:teamId/documents/:key/revisions",
    async (req, res) => {
      const team = await svc.getById(req.params.teamId as string);
      if (!team) {
        res.status(404).json({ error: "Team not found" });
        return;
      }
      assertCompanyAccess(req, team.companyId);
      const revisions = await docSvc.listRevisions(
        team.id,
        team.companyId,
        req.params.key as string,
      );
      res.json(revisions);
    },
  );

  return router;
}
