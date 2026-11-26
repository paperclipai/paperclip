import { Router } from "express";
import type { Db } from "@paperclipai/db";

import { unprocessable } from "../errors.js";
import { logActivity } from "../services/activity-log.js";
import {
  managedAgentProfileService,
  type ManagedAgentProfileInput,
} from "../services/managed-agent-profiles.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

function profileInput(value: unknown): ManagedAgentProfileInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw unprocessable("Managed Agent profile body is required");
  }
  const body = value as Record<string, unknown>;
  return {
    profileKey: String(body.profileKey ?? ""),
    displayName: String(body.displayName ?? ""),
    anthropicAgentId: String(body.anthropicAgentId ?? ""),
    agentVersion: String(body.agentVersion ?? ""),
    environmentId: String(body.environmentId ?? ""),
    defaultModel: String(body.defaultModel ?? "claude-sonnet-5"),
    defaultMaxListCostUsd: Number(body.defaultMaxListCostUsd ?? 1),
    apiKeySecretId: String(body.apiKeySecretId ?? ""),
    enabled: body.enabled === true,
    retentionAcknowledged: body.retentionAcknowledged === true,
    qualification:
      body.qualification
      && typeof body.qualification === "object"
      && !Array.isArray(body.qualification)
        ? body.qualification as Record<string, unknown>
        : {},
  };
}

export function managedAgentProfileRoutes(db: Db) {
  const router = Router();
  const profiles = managedAgentProfileService(db);

  router.get("/companies/:companyId/managed-agent-profiles", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await profiles.list(companyId));
  });

  router.post("/companies/:companyId/managed-agent-profiles", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const profile = await profiles.upsert(companyId, profileInput(req.body));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "managed_agent_profile.upserted",
      entityType: "managed_agent_profile",
      entityId: profile.id,
      details: {
        profileKey: profile.profileKey,
        service: profile.service,
        agentVersion: profile.agentVersion,
        environmentId: profile.environmentId,
        model: profile.defaultModel,
        enabled: profile.enabled,
        retentionAcknowledged: profile.retentionAcknowledged,
        defaultMaxListCostCents: profile.defaultMaxListCostCents,
        qualifiedRevision: profile.qualifiedRevision,
      },
    });
    res.status(201).json(profile);
  });

  return router;
}
