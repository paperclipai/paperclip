import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { rt2EnterpriseService } from "../services/rt2-enterprise.js";
import { logActivity } from "../services/activity-log.js";
import { assertCompanyAccess } from "./authz.js";

export function rt2EnterpriseRoutes(db: Db) {
  const router = Router();
  const enterpriseService = rt2EnterpriseService(db);

  function rolloutAuditActor(req: Request) {
    return {
      actorType: req.actor?.type === "agent" ? "agent" as const : "system" as const,
      actorId: req.actor?.userId ?? "system",
    };
  }

  router.get("/companies/:companyId/rt2/enterprise/rollout", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const overview = await enterpriseService.getRolloutOverview(companyId);
      return res.json(overview);
    } catch (error) {
      console.error("Error getting RT2 rollout overview:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/companies/:companyId/rt2/enterprise/rollout", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const result = await enterpriseService.saveRolloutSettings(companyId, req.body ?? {});
      const actor = rolloutAuditActor(req);
      await logActivity(db, {
        companyId,
        ...actor,
        action: "rt2.rollout.settings_saved",
        entityType: "rt2_enterprise_rollout",
        entityId: companyId,
        details: { changed: result.changed },
      });
      return res.status(200).json(result);
    } catch (error) {
      console.error("Error saving RT2 rollout settings:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/companies/:companyId/rt2/enterprise/sso/validate", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const result = await enterpriseService.validateSsoHandshake(companyId, req.body ?? {});
      const actor = rolloutAuditActor(req);
      await logActivity(db, {
        companyId,
        ...actor,
        action: "rt2.rollout.sso_handshake_validated",
        entityType: "rt2_enterprise_rollout",
        entityId: result.evidenceId ?? companyId,
        details: {
          evidenceId: result.evidenceId,
          provider: result.provider,
          status: result.status,
          failureReasons: result.failureReasons ?? [],
          warnings: result.warnings,
        },
      });
      return res.status(200).json(result);
    } catch (error) {
      console.error("Error validating RT2 rollout SSO metadata:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/companies/:companyId/rt2/enterprise/scim/preview", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const result = await enterpriseService.createScimPreview(companyId, req.body ?? {});
      const actor = rolloutAuditActor(req);
      await logActivity(db, {
        companyId,
        ...actor,
        action: "rt2.rollout.scim_previewed",
        entityType: "rt2_enterprise_rollout",
        entityId: companyId,
        details: {
          previewId: result.previewId,
          previewFingerprint: result.previewFingerprint,
          status: result.status,
          summary: result.summary,
        },
      });
      return res.status(200).json(result);
    } catch (error) {
      console.error("Error previewing RT2 SCIM sync:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/companies/:companyId/rt2/enterprise/scim/apply", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const result = await enterpriseService.applyScimPreview(companyId, req.body ?? {});
      if (!("evidenceId" in result)) {
        return res.status(result.statusCode).json(result);
      }

      const actor = rolloutAuditActor(req);
      await logActivity(db, {
        companyId,
        ...actor,
        action: "rt2.rollout.scim_applied",
        entityType: "rt2_enterprise_rollout",
        entityId: result.evidenceId,
        details: {
          evidenceId: result.evidenceId,
          previewId: result.previewId,
          previewFingerprint: result.previewFingerprint,
          status: result.status,
          summary: result.summary,
          failureReasons: result.failureReasons,
          rollbackCandidateCount: result.rollbackCandidates.length,
        },
      });
      return res.status(200).json(result);
    } catch (error) {
      console.error("Error applying RT2 SCIM preview:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ===== SSO Connections =====

  /**
   * POST /companies/:companyId/rt2/sso/connections
   * Create SSO connection
   */
  router.post("/companies/:companyId/rt2/sso/connections", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { provider, providerConfig, clientId, clientSecret, issuerUrl, metadataUrl, certificate, userMapping, autoProvision, defaultRole } = req.body;

      if (!provider) {
        return res.status(400).json({ error: "provider is required" });
      }

      const connection = await enterpriseService.createSsoConnection(companyId, provider, {
        providerConfig,
        clientId,
        clientSecret,
        issuerUrl,
        metadataUrl,
        certificate,
        userMapping,
        autoProvision,
        defaultRole,
      });

      return res.status(201).json(connection);
    } catch (error) {
      console.error("Error creating SSO connection:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /companies/:companyId/rt2/sso/connections
   * Get SSO connections
   */
  router.get("/companies/:companyId/rt2/sso/connections", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const connections = await enterpriseService.getSsoConnections(companyId);

      return res.json(connections);
    } catch (error) {
      console.error("Error getting SSO connections:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * PATCH /companies/:companyId/rt2/sso/connections/:connectionId
   * Update SSO connection
   */
  router.patch("/companies/:companyId/rt2/sso/connections/:connectionId", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const connectionId = req.params.connectionId;
      const updates = req.body;

      const connection = await enterpriseService.updateSsoConnection(companyId, connectionId, updates);

      return res.json(connection);
    } catch (error) {
      console.error("Error updating SSO connection:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ===== Company Templates =====

  /**
   * POST /companies/:companyId/rt2/templates
   * Create company template
   */
  router.post("/companies/:companyId/rt2/templates", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { name, category, templateData, description, isPublic } = req.body;

      if (!name || !category || !templateData) {
        return res.status(400).json({ error: "name, category, and templateData are required" });
      }

      const tmpl = await enterpriseService.createCompanyTemplate(name, category, templateData, {
        description,
        isPublic,
        authorCompanyId: companyId,
      });

      return res.status(201).json(tmpl);
    } catch (error) {
      console.error("Error creating company template:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /companies/:companyId/rt2/templates
   * Get templates for company
   */
  router.get("/companies/:companyId/rt2/templates", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const templates = await enterpriseService.getTemplatesByAuthor(companyId);

      return res.json(templates);
    } catch (error) {
      console.error("Error getting company templates:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /rt2/templates/public
   * Get public templates
   */
  router.get("/rt2/templates/public", async (req, res) => {
    try {
      const { category } = req.query;

      const templates = await enterpriseService.getPublicTemplates(category as string | undefined);

      return res.json(templates);
    } catch (error) {
      console.error("Error getting public templates:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * POST /companies/:companyId/rt2/templates/:templateId/use
   * Increment template usage
   */
  router.post("/companies/:companyId/rt2/templates/:templateId/use", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const templateId = req.params.templateId;

      await enterpriseService.incrementTemplateUsage(templateId);

      return res.json({ success: true });
    } catch (error) {
      console.error("Error incrementing template usage:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ===== Tenant Policies =====

  /**
   * POST /companies/:companyId/rt2/tenant-policies
   * Create tenant policy
   */
  router.post("/companies/:companyId/rt2/tenant-policies", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { policyType, isolationLevel, dataIsolation, resourceSharing, networkPolicy, complianceConfig, quotas } = req.body;

      if (!policyType) {
        return res.status(400).json({ error: "policyType is required" });
      }

      const policy = await enterpriseService.createTenantPolicy(companyId, policyType, {
        isolationLevel,
        dataIsolation,
        resourceSharing,
        networkPolicy,
        complianceConfig,
        quotas,
      });

      return res.status(201).json(policy);
    } catch (error) {
      console.error("Error creating tenant policy:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /companies/:companyId/rt2/tenant-policies
   * Get tenant policy
   */
  router.get("/companies/:companyId/rt2/tenant-policies", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const policy = await enterpriseService.getTenantPolicy(companyId);

      if (!policy) {
        return res.status(404).json({ error: "Tenant policy not found" });
      }

      return res.json(policy);
    } catch (error) {
      console.error("Error getting tenant policy:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * PATCH /companies/:companyId/rt2/tenant-policies/:policyId
   * Update tenant policy
   */
  router.patch("/companies/:companyId/rt2/tenant-policies/:policyId", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const policyId = req.params.policyId;
      const updates = req.body;

      const policy = await enterpriseService.updateTenantPolicy(companyId, policyId, updates);

      return res.json(policy);
    } catch (error) {
      console.error("Error updating tenant policy:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ===== Binding Modes =====

  /**
   * POST /companies/:companyId/rt2/binding-modes
   * Create binding mode
   */
  router.post("/companies/:companyId/rt2/binding-modes", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { mode, networkConfig, securityConfig, environment } = req.body;

      if (!mode || !networkConfig) {
        return res.status(400).json({ error: "mode and networkConfig are required" });
      }

      const binding = await enterpriseService.createBindingMode(companyId, mode, networkConfig, {
        securityConfig,
        environment,
      });

      return res.status(201).json(binding);
    } catch (error) {
      console.error("Error creating binding mode:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /companies/:companyId/rt2/binding-modes
   * Get binding modes
   */
  router.get("/companies/:companyId/rt2/binding-modes", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const bindings = await enterpriseService.getBindingModes(companyId);

      return res.json(bindings);
    } catch (error) {
      console.error("Error getting binding modes:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * PATCH /companies/:companyId/rt2/binding-modes/:bindingId
   * Update binding mode
   */
  router.patch("/companies/:companyId/rt2/binding-modes/:bindingId", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const bindingId = req.params.bindingId;
      const updates = req.body;

      const binding = await enterpriseService.updateBindingMode(companyId, bindingId, updates);

      return res.json(binding);
    } catch (error) {
      console.error("Error updating binding mode:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
