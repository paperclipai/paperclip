import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { rt2FederationService } from "../services/rt2-enterprise.js";
import { assertCompanyAccess } from "./authz.js";

export function rt2FederationRoutes(db: Db) {
  const router = Router();
  const svc = rt2FederationService(db);

  // FED-01: Create a federation partnership
  // POST /api/companies/:companyId/rt2/federation/partners
  router.post("/companies/:companyId/rt2/federation/partners", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const {
        partnerCompanyId,
        partnershipType,
        evidenceSharingLevel,
        trustLevel,
        allowedEvidenceTypes,
      } = req.body;

      const partner = await svc.createFederationPartner(companyId, {
        partnerCompanyId,
        partnershipType,
        evidenceSharingLevel,
        trustLevel,
        allowedEvidenceTypes,
      });
      res.status(201).json({ data: partner });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // FED-01: List federation partners
  // GET /api/companies/:companyId/rt2/federation/partners
  router.get("/companies/:companyId/rt2/federation/partners", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const partners = await svc.getFederationPartners(companyId);
    res.json({ data: partners });
  });

  // FED-01: Get a specific federation partner
  // GET /api/companies/:companyId/rt2/federation/partners/:partnerId
  router.get("/companies/:companyId/rt2/federation/partners/:partnerId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const partner = await svc.getFederationPartner(companyId, req.params.partnerId);
    if (!partner) {
      return res.status(404).json({ error: "Partner not found" });
    }
    res.json({ data: partner });
  });

  // FED-01: Update a federation partnership
  // PATCH /api/companies/:companyId/rt2/federation/partners/:partnerId
  router.patch("/companies/:companyId/rt2/federation/partners/:partnerId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { status, evidenceSharingLevel, trustLevel, allowedEvidenceTypes } = req.body;
    const updated = await svc.updateFederationPartner(companyId, req.params.partnerId, {
      status,
      evidenceSharingLevel,
      trustLevel,
      allowedEvidenceTypes,
    });
    if (!updated) {
      return res.status(404).json({ error: "Partner not found" });
    }
    res.json({ data: updated });
  });

  // FED-01: Create an evidence sharing contract
  // POST /api/companies/:companyId/rt2/federation/contracts
  router.post("/companies/:companyId/rt2/federation/contracts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const { federationPartnerId, contractType, evidenceTypes, transformationRules } = req.body;

      const contract = await svc.createFederationContract(companyId, {
        federationPartnerId,
        contractType,
        evidenceTypes: evidenceTypes ?? [],
        transformationRules,
      });
      res.status(201).json({ data: contract });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // FED-01: List evidence contracts
  // GET /api/companies/:companyId/rt2/federation/contracts
  router.get("/companies/:companyId/rt2/federation/contracts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { federationPartnerId } = req.query;
    const contracts = await svc.getFederationContracts(
      companyId,
      federationPartnerId as string | undefined,
    );
    res.json({ data: contracts });
  });

  // FED-02: Record an audit trail entry
  // POST /api/companies/:companyId/rt2/federation/audit-trails
  router.post("/companies/:companyId/rt2/federation/audit-trails", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const {
        federationPartnerId,
        evidenceType,
        evidenceId,
        accessAction,
        accessResult,
        accessedByActorId,
        accessedByActorType,
        contractId,
        sharedDataSummary,
        redactionNotes,
        ipAddress,
        userAgent,
      } = req.body;

      const trail = await svc.recordFederationAuditTrail(companyId, {
        federationPartnerId,
        evidenceType,
        evidenceId,
        accessAction,
        accessResult,
        accessedByActorId,
        accessedByActorType,
        contractId,
        sharedDataSummary,
        redactionNotes,
        ipAddress,
        userAgent,
      });
      res.status(201).json({ data: trail });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // FED-02: Get audit trails
  // GET /api/companies/:companyId/rt2/federation/audit-trails
  router.get("/companies/:companyId/rt2/federation/audit-trails", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { federationPartnerId, evidenceType, limit } = req.query;
    const trails = await svc.getFederationAuditTrails(companyId, {
      federationPartnerId: federationPartnerId as string | undefined,
      evidenceType: evidenceType as string | undefined,
      limit: limit ? parseInt(limit as string) : undefined,
    });
    res.json({ data: trails });
  });

  // FED-02: Get audit report
  // GET /api/companies/:companyId/rt2/federation/audit-report
  router.get("/companies/:companyId/rt2/federation/audit-report", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { partnerId, since } = req.query;
    const report = await svc.getFederationAuditReport(companyId, {
      partnerId: partnerId as string | undefined,
      since: since ? new Date(since as string) : undefined,
    });
    res.json({ data: report });
  });

  return router;
}
