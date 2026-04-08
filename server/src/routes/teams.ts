import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createTeamSchema,
  updateTeamSchema,
  addTeamMemberSchema,
  createWorkflowStatusSchema,
  updateWorkflowStatusSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { teamService, workflowStatusService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function teamRoutes(db: Db) {
  const router = Router();
  const svc = teamService(db);
  const wfSvc = workflowStatusService(db);

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
      if (err.status === 409) {
        res.status(409).json({ error: err.message });
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
    const member = await svc.addMember(teamId, req.body);
    if (!member) {
      res.status(409).json({ error: "Member already exists in team" });
      return;
    }
    res.status(201).json(member);
  });

  router.delete("/companies/:companyId/teams/:teamId/members/:memberId", async (req, res) => {
    const memberId = req.params.memberId as string;
    const team = await svc.getById(req.params.teamId as string);
    if (!team) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    assertCompanyAccess(req, team.companyId);
    const removed = await svc.removeMember(memberId);
    if (!removed) {
      res.status(404).json({ error: "Member not found" });
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

  return router;
}
