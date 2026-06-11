import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  type DeploymentExposure,
  type DeploymentMode,
  createToolApplicationSchema,
  createToolConnectionSchema,
  createToolPolicySchema,
  createToolProfileBindingForProfileSchema,
  createToolProfileEntryForProfileSchema,
  createToolProfileWithEntriesSchema,
  createToolTrustRuleFromActionRequestSchema,
  importMcpJsonSchema,
  revokeToolTrustRuleSchema,
  toolPolicyTestRequestSchema,
  unbindToolProfileBindingSchema,
  updateToolApplicationSchema,
  updateToolConnectionSchema,
  updateToolPolicySchema,
  updateToolProfileEntrySchema,
  updateToolProfileWithEntriesSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { getActorInfo, assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity, toolAccessPolicyService, toolAccessService } from "../services/index.js";

export function toolAccessRoutes(
  db: Db,
  options: {
    deploymentMode?: DeploymentMode;
    deploymentExposure?: DeploymentExposure;
    trustedLocalStdioRuntimeHost?: string | null;
  } = {},
) {
  const router = Router();
  const svc = toolAccessService(db, options);
  const policySvc = toolAccessPolicyService(db);

  router.get("/companies/:companyId/tools/examples", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ examples: await svc.listExamples(companyId) });
  });

  router.post("/companies/:companyId/tools/examples/:id/install", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.installExample(companyId, req.params.id as string, getActorInfo(req));
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_example.installed",
      entityType: "tool_example",
      entityId: result.example.id,
      details: {
        created: result.created,
        applicationId: result.application.id,
        connectionId: result.connection.id,
        profileId: result.profile.id,
        profileEntryCount: result.profileEntries.length,
      },
    });
    res.status(result.created ? 201 : 200).json(result);
  });

  router.post("/companies/:companyId/tools/examples/:id/smoke", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.smokeExample(companyId, req.params.id as string, getActorInfo(req));
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_example.smoke_run",
      entityType: "tool_example",
      entityId: result.exampleId,
      details: {
        ok: result.ok,
        actor: result.actor,
        connectionId: result.connection.id,
        profileId: result.profile.id,
        checks: result.checks.map((check) => ({
          name: check.name,
          ok: check.ok,
          toolName: check.toolName ?? null,
          decision: check.decision ?? null,
          reasonCode: check.reasonCode ?? null,
        })),
      },
    });
    res.json(result);
  });

  router.get("/companies/:companyId/tools/applications", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ applications: await svc.listApplications(companyId) });
  });

  router.post("/companies/:companyId/tools/applications", validate(createToolApplicationSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const application = await svc.createApplication(companyId, req.body);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_application.created",
        entityType: "tool_application",
        entityId: application.id,
        details: { type: application.type, name: application.name },
      });
      res.status(201).json(application);
    } catch (error) {
      svc.ensureNoDuplicateNameError(error);
    }
  });

  router.patch("/tool-applications/:applicationId", validate(updateToolApplicationSchema), async (req, res) => {
    assertBoard(req);
    const existing = await svc.getApplication(req.params.applicationId as string);
    assertCompanyAccess(req, existing.companyId);
    try {
      const application = await svc.updateApplication(existing.id, req.body);
      await logActivity(db, {
        companyId: application.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_application.updated",
        entityType: "tool_application",
        entityId: application.id,
        details: { status: application.status, name: application.name },
      });
      res.json(application);
    } catch (error) {
      svc.ensureNoDuplicateNameError(error);
    }
  });

  router.delete("/tool-applications/:applicationId", async (req, res) => {
    assertBoard(req);
    const existing = await svc.getApplication(req.params.applicationId as string);
    assertCompanyAccess(req, existing.companyId);
    const application = await svc.deleteApplication(existing.id);
    await logActivity(db, {
      companyId: application.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_application.deleted",
      entityType: "tool_application",
      entityId: application.id,
      details: { type: application.type, name: application.name },
    });
    res.json(application);
  });

  router.get("/companies/:companyId/tools/connections", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ connections: await svc.listConnections(companyId) });
  });

  router.post("/companies/:companyId/tools/connections", validate(createToolConnectionSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const connection = await svc.createConnection(companyId, req.body);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_connection.created",
        entityType: "tool_connection",
        entityId: connection.id,
        details: {
          transport: connection.transport,
          status: connection.status,
          enabled: connection.enabled,
          credentialRefCount: (connection.credentialRefs ?? []).length + connection.credentialSecretRefs.length,
        },
      });
      res.status(201).json(connection);
    } catch (error) {
      svc.ensureNoDuplicateNameError(error);
    }
  });

  router.get("/tool-connections/:connectionId", async (req, res) => {
    assertBoard(req);
    const connection = await svc.getConnection(req.params.connectionId as string);
    assertCompanyAccess(req, connection.companyId);
    res.json(connection);
  });

  router.patch("/tool-connections/:connectionId", validate(updateToolConnectionSchema), async (req, res) => {
    assertBoard(req);
    const existing = await svc.getConnection(req.params.connectionId as string);
    assertCompanyAccess(req, existing.companyId);
    const connection = await svc.updateConnection(existing.id, req.body);
    await logActivity(db, {
      companyId: connection.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_connection.updated",
      entityType: "tool_connection",
      entityId: connection.id,
      details: {
        status: connection.status,
        enabled: connection.enabled,
        credentialRefCount: (connection.credentialRefs ?? []).length + connection.credentialSecretRefs.length,
      },
    });
    res.json(connection);
  });

  router.delete("/tool-connections/:connectionId", async (req, res) => {
    assertBoard(req);
    const existing = await svc.getConnection(req.params.connectionId as string);
    assertCompanyAccess(req, existing.companyId);
    const connection = await svc.archiveConnection(existing.id);
    await logActivity(db, {
      companyId: connection.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_connection.archived",
      entityType: "tool_connection",
      entityId: connection.id,
      details: { transport: connection.transport },
    });
    res.json(connection);
  });

  router.post("/tool-connections/:connectionId/health-check", async (req, res) => {
    assertBoard(req);
    const existing = await svc.getConnection(req.params.connectionId as string);
    assertCompanyAccess(req, existing.companyId);
    res.json(await svc.checkHealth(existing.id, getActorInfo(req)));
  });

  router.post("/tool-connections/:connectionId/catalog/refresh", async (req, res) => {
    assertBoard(req);
    const existing = await svc.getConnection(req.params.connectionId as string);
    assertCompanyAccess(req, existing.companyId);
    res.json(await svc.refreshCatalog(existing.id, getActorInfo(req)));
  });

  router.get("/tool-connections/:connectionId/catalog", async (req, res) => {
    assertBoard(req);
    const existing = await svc.getConnection(req.params.connectionId as string);
    assertCompanyAccess(req, existing.companyId);
    res.json({ catalog: await svc.listCatalog(existing.id, existing.companyId) });
  });

  router.get("/companies/:companyId/tools/profiles", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ profiles: await svc.listProfiles(companyId) });
  });

  router.post("/companies/:companyId/tools/profiles", validate(createToolProfileWithEntriesSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const profile = await svc.createProfile(companyId, req.body);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_profile.created",
        entityType: "tool_profile",
        entityId: profile.id,
        details: { name: profile.name, entryCount: profile.entries.length },
      });
      res.status(201).json(profile);
    } catch (error) {
      svc.ensureNoDuplicateNameError(error);
    }
  });

  router.get("/companies/:companyId/tools/profiles/effective/agents/:agentId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getEffectiveProfilesForAgent(companyId, req.params.agentId as string));
  });

  router.patch("/tool-profiles/:profileId", validate(updateToolProfileWithEntriesSchema), async (req, res) => {
    assertBoard(req);
    const existing = await svc.getProfile(req.params.profileId as string);
    assertCompanyAccess(req, existing.companyId);
    try {
      const profile = await svc.updateProfile(existing.id, req.body);
      await logActivity(db, {
        companyId: profile.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_profile.updated",
        entityType: "tool_profile",
        entityId: profile.id,
        details: { status: profile.status, entryCount: profile.entries.length },
      });
      res.json(profile);
    } catch (error) {
      svc.ensureNoDuplicateNameError(error);
    }
  });

  router.post("/tool-profiles/:profileId/entries", validate(createToolProfileEntryForProfileSchema), async (req, res) => {
    assertBoard(req);
    const existing = await svc.getProfile(req.params.profileId as string);
    assertCompanyAccess(req, existing.companyId);
    const entry = await svc.addProfileEntry(existing.id, req.body);
    await logActivity(db, {
      companyId: entry.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_profile_entry.created",
      entityType: "tool_profile_entry",
      entityId: entry.id,
      details: { profileId: entry.profileId, selectorType: entry.selectorType, effect: entry.effect },
    });
    res.status(201).json(entry);
  });

  router.patch("/tool-profile-entries/:entryId", validate(updateToolProfileEntrySchema), async (req, res) => {
    assertBoard(req);
    const existing = await svc.getProfileEntry(req.params.entryId as string);
    assertCompanyAccess(req, existing.companyId);
    const entry = await svc.updateProfileEntry(existing.id, req.body);
    await logActivity(db, {
      companyId: entry.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_profile_entry.updated",
      entityType: "tool_profile_entry",
      entityId: entry.id,
      details: { profileId: entry.profileId, selectorType: entry.selectorType, effect: entry.effect },
    });
    res.json(entry);
  });

  router.delete("/tool-profile-entries/:entryId", async (req, res) => {
    assertBoard(req);
    const existing = await svc.getProfileEntry(req.params.entryId as string);
    assertCompanyAccess(req, existing.companyId);
    const entry = await svc.deleteProfileEntry(existing.id);
    await logActivity(db, {
      companyId: entry.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_profile_entry.deleted",
      entityType: "tool_profile_entry",
      entityId: entry.id,
      details: { profileId: entry.profileId },
    });
    res.json(entry);
  });

  router.post(
    "/companies/:companyId/tools/profiles/:profileId/bind",
    validate(createToolProfileBindingForProfileSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const existing = await svc.getProfile(req.params.profileId as string, companyId);
      try {
        const binding = await svc.bindProfile(existing.id, req.body, getActorInfo(req));
        await logActivity(db, {
          companyId,
          actorType: "user",
          actorId: req.actor.userId ?? "board",
          action: "tool_profile_binding.created",
          entityType: "tool_profile_binding",
          entityId: binding.id,
          details: { profileId: binding.profileId, targetType: binding.targetType, targetId: binding.targetId },
        });
        res.status(201).json(binding);
      } catch (error) {
        svc.ensureNoDuplicateNameError(error);
      }
    },
  );

  router.post(
    "/companies/:companyId/tools/profiles/:profileId/unbind",
    validate(unbindToolProfileBindingSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const existing = await svc.getProfile(req.params.profileId as string, companyId);
      const result = await svc.unbindProfile(existing.id, req.body);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_profile_binding.deleted",
        entityType: "tool_profile",
        entityId: existing.id,
        details: { targetType: req.body.targetType, targetId: req.body.targetId, unbound: result.unbound },
      });
      res.json(result);
    },
  );

  router.get("/companies/:companyId/tools/runtime-slots", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ runtimeSlots: await svc.listRuntimeSlots(companyId) });
  });

  router.post("/companies/:companyId/tools/runtime-slots/:id/stop", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.stopRuntimeSlot(companyId, req.params.id as string, getActorInfo(req)));
  });

  router.post("/companies/:companyId/tools/runtime-slots/:id/restart", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.restartRuntimeSlot(companyId, req.params.id as string, getActorInfo(req)));
  });

  router.get("/companies/:companyId/tools/runtime-health", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getRuntimeHealth(companyId));
  });

  router.get("/companies/:companyId/tools/runs/:runId/decisions", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getRunDecisionLookup(companyId, req.params.runId as string));
  });

  router.get("/companies/:companyId/tools/trust-rules", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ trustRules: await policySvc.listTrustRules(companyId) });
  });

  router.get("/companies/:companyId/tools/policies", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ policies: await policySvc.listPolicies(companyId) });
  });

  router.post("/companies/:companyId/tools/policies", validate(createToolPolicySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const policy = await policySvc.createPolicy(companyId, req.body, { userId: req.actor.userId ?? null });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_policy.created",
        entityType: "tool_policy",
        entityId: policy.id,
        details: { name: policy.name, policyType: policy.policyType, priority: policy.priority },
      });
      res.status(201).json(policy);
    } catch (error) {
      policySvc.ensureNoDuplicatePolicyNameError(error);
    }
  });

  router.patch("/companies/:companyId/tools/policies/:policyId", validate(updateToolPolicySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const policy = await policySvc.updatePolicy({
        companyId,
        policyId: req.params.policyId as string,
        body: req.body,
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_policy.updated",
        entityType: "tool_policy",
        entityId: policy.id,
        details: { name: policy.name, policyType: policy.policyType, enabled: policy.enabled, priority: policy.priority },
      });
      res.json(policy);
    } catch (error) {
      policySvc.ensureNoDuplicatePolicyNameError(error);
    }
  });

  router.delete("/companies/:companyId/tools/policies/:policyId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const policy = await policySvc.deletePolicy({
      companyId,
      policyId: req.params.policyId as string,
    });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_policy.deleted",
      entityType: "tool_policy",
      entityId: policy.id,
      details: { name: policy.name, policyType: policy.policyType },
    });
    res.json(policy);
  });

  router.post(
    "/companies/:companyId/tools/action-requests/:actionRequestId/trust-rule",
    validate(createToolTrustRuleFromActionRequestSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const policy = await policySvc.createTrustRuleFromActionRequest({
        companyId,
        actionRequestId: req.params.actionRequestId as string,
        body: req.body,
        actor: { userId: req.actor.userId ?? null },
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_trust_rule.created",
        entityType: "tool_policy",
        entityId: policy.id,
        details: {
          name: policy.name,
          selectors: policy.selectors,
          sourceActionRequestId: req.params.actionRequestId,
        },
      });
      res.status(201).json(policy);
    },
  );

  router.post("/companies/:companyId/tools/trust-rules/:policyId/revoke", validate(revokeToolTrustRuleSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const policy = await policySvc.revokeTrustRule({
      companyId,
      policyId: req.params.policyId as string,
      body: req.body,
      actor: { userId: req.actor.userId ?? null },
    });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_trust_rule.revoked",
      entityType: "tool_policy",
      entityId: policy.id,
      details: { reason: req.body.reason ?? null },
    });
    res.json(policy);
  });

  router.get("/companies/:companyId/tools/stdio-templates", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ templates: svc.approvedStdioTemplates() });
  });

  router.post("/companies/:companyId/tools/mcp/import-json", validate(importMcpJsonSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const preview = await svc.previewMcpJsonImport(req.body);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_connection.import_mcp_json_previewed",
      entityType: "tool_connection_import",
      entityId: companyId,
      details: { draftCount: preview.drafts.length },
    });
    res.json(preview);
  });

  router.post("/companies/:companyId/tools/policy/test", validate(toolPolicyTestRequestSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const input = { ...req.body, companyId };
    const decision = await policySvc.decide(input);
    let auditEvent = null;
    if (input.writeAuditEvent === true) {
      auditEvent = await policySvc.writeAudit(input, decision);
    }
    res.json({ decision, auditEvent });
  });

  return router;
}
