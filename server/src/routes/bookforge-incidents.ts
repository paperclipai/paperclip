import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  agentService,
  buildBookforgeRepairAcceptanceGate,
  buildBookforgeRepairIssueDraft,
  dispatchBookforgeIncident,
  heartbeatService,
  issueService,
  validateBookforgeRepairAcceptance,
} from "../services/index.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function bookforgeIncidentRoutes(db: Db) {
  const router = Router();
  const agents = agentService(db);
  const heartbeat = heartbeatService(db);
  const issues = issueService(db);

  router.post("/companies/:companyId/bookforge-incidents/dispatch", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const actor = getActorInfo(req);
    const sourceAgentId = actor.agentId ?? readString(req.body?.sourceAgentId);
    const sourceAgent = sourceAgentId ? await agents.getById(sourceAgentId) : null;
    const isBoardActor = actor.actorType === "user";
    const sourceAgentName = sourceAgent?.name ?? readString(req.body?.sourceAgentName) ?? (isBoardActor ? "board" : null);
    const allAgents = await agents.list(companyId);

    const result = await dispatchBookforgeIncident({
      agents: allAgents.map((agent) => ({ id: agent.id, name: agent.name, status: agent.status })),
      sourceAgentId,
      sourceAgentName,
      issueId: readString(req.body?.issueId),
      incidentKind: readString(req.body?.incidentKind) ?? "general",
      severity: readString(req.body?.severity) ?? "medium",
      summary: readString(req.body?.summary),
      maxFanout: typeof req.body?.maxFanout === "number" ? req.body.maxFanout : undefined,
      allowNonWatchmanSource: isBoardActor && req.body?.allowBoardOverride === true,
      wakeup: heartbeat.wakeup,
    });

    let repairIssue = null;
    const repairIssueDraft = buildBookforgeRepairIssueDraft({
      plan: result,
      source: {
        agents: allAgents.map((agent) => ({ id: agent.id, name: agent.name, status: agent.status })),
        sourceAgentId,
        sourceAgentName,
        issueId: readString(req.body?.issueId),
        incidentKind: readString(req.body?.incidentKind) ?? "general",
        severity: readString(req.body?.severity) ?? "medium",
        summary: readString(req.body?.summary),
        maxFanout: typeof req.body?.maxFanout === "number" ? req.body.maxFanout : undefined,
        allowNonWatchmanSource: isBoardActor && req.body?.allowBoardOverride === true,
      },
    });
    if (repairIssueDraft && req.body?.createRepairIssue !== false) {
      const existing = await issues.list(companyId, {
        q: repairIssueDraft.title,
        status: "todo,in_progress,blocked",
        limit: 10,
      });
      repairIssue = existing.find((issue) => issue.title === repairIssueDraft.title) ?? null;
      if (!repairIssue) {
        repairIssue = await issues.create(companyId, {
          title: repairIssueDraft.title,
          description: repairIssueDraft.description,
          priority: repairIssueDraft.priority,
          status: repairIssueDraft.status,
          assigneeAgentId: repairIssueDraft.assigneeAgentId,
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          originKind: repairIssueDraft.originKind,
          originId: repairIssueDraft.originId,
        });
      }
      await queueIssueAssignmentWakeup({
        heartbeat,
        issue: repairIssue,
        reason: "bookforge_repair_issue_assigned",
        mutation: "bookforge_incident_dispatch",
        contextSource: "bookforge.incident.repair_issue",
        requestedByActorType: "system",
        requestedByActorId: actor.actorId,
        rethrowOnError: true,
      });
    }

    res.json({ ...result, repairIssue });
  });

  router.post("/companies/:companyId/bookforge-incidents/repair-acceptance/validate", (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const incidentKind = readString(req.body?.incidentKind) ?? "chapter_repair";
    const summary = readString(req.body?.summary) ?? "chapter repair";
    const gate = buildBookforgeRepairAcceptanceGate(incidentKind, summary);
    if (!gate) {
      res.status(422).json({
        accepted: false,
        missing: [],
        gateVersion: null,
        message: "Request does not look like a Bookforge chapter repair incident.",
      });
      return;
    }

    res.json(validateBookforgeRepairAcceptance(req.body?.evidence ?? {}, gate));
  });

  return router;
}
