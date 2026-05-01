import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { rt2AgentMarketplaceService } from "../services/rt2-agent-marketplace.js";
import { assertCompanyAccess } from "./authz.js";
import { badRequest } from "../errors.js";

export function rt2AgentMarketplaceRoutes(db: Db) {
  const router = Router();
  const svc = rt2AgentMarketplaceService(db);

  // ===== Public Marketplace (Phase 72) =====

  // Public: List marketplace agents (only approved, public evidence contract)
  router.get("/rt2/marketplace/agents", async (req, res) => {
    const category = req.query.category as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

    const agents = await svc.listPublicMarketplaceAgents(category, limit, offset);
    res.json(agents);
  });

  // Public: Search marketplace agents (only approved)
  router.get("/rt2/marketplace/search", async (req, res) => {
    const query = req.query.q as string;
    const category = req.query.category as string | undefined;

    if (!query) {
      throw badRequest("Search query 'q' is required");
    }

    const agents = await svc.searchMarketplaceAgents(query, category);
    res.json(agents);
  });

  // Public: Get marketplace listing (public evidence contract)
  router.get("/rt2/marketplace/agents/:listingId", async (req, res) => {
    const { listingId } = req.params;
    const includePrivate = req.query.includePrivate === "true";

    if (includePrivate) {
      // Company-scoped view: full evidence
      const listing = await svc.getMarketplaceListing(listingId);
      if (!listing) {
        throw badRequest("Listing not found");
      }
      res.json(listing);
    } else {
      // Public view: public evidence contract
      const listing = await svc.getPublicMarketplaceListing(listingId);
      if (!listing) {
        throw badRequest("Listing not found or not approved");
      }
      res.json(listing);
    }
  });

  // ===== Company-Scoped Routes =====

  router.get("/companies/:companyId/rt2/marketplace/agents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const category = req.query.category as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

    const agents = await svc.listCompanyMarketplaceAgents(companyId, category, limit, offset);
    res.json(agents);
  });

  // Company-scoped: Search marketplace agents (includes draft/pending own listings)
  router.get("/companies/:companyId/rt2/marketplace/search", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const query = req.query.q as string;
    const category = req.query.category as string | undefined;

    if (!query) {
      throw badRequest("Search query 'q' is required");
    }

    const agents = await svc.searchCompanyMarketplaceAgents(companyId, query, category);
    res.json(agents);
  });

  // Create marketplace listing (draft by default)
  router.post("/companies/:companyId/rt2/marketplace/listings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { name, category, adapterType, description, tags, pricingType, pricePerTaskCents, monthlySubscriptionCents, capabilities } = req.body;

    if (!name || !category || !adapterType) {
      throw badRequest("name, category, and adapterType are required");
    }

    const listing = await svc.createListing(companyId, name, category, adapterType, {
      description,
      tags,
      pricingType,
      pricePerTaskCents,
      monthlySubscriptionCents,
      capabilities,
    });

    res.json(listing);
  });

  // Submit listing for approval
  router.post("/companies/:companyId/rt2/marketplace/listings/:listingId/submit-for-approval", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { listingId } = req.params;

    const listing = await svc.submitForApproval(listingId, companyId);
    res.json(listing);
  });

  // Approve listing (company admin)
  router.post("/companies/:companyId/rt2/marketplace/listings/:listingId/approve", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { listingId } = req.params;

    const listing = await svc.approveListing(listingId);
    res.json(listing);
  });

  // Reject listing (company admin)
  router.post("/companies/:companyId/rt2/marketplace/listings/:listingId/reject", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { listingId } = req.params;
    const { reason } = req.body;

    if (!reason) {
      throw badRequest("reason is required");
    }

    const listing = await svc.rejectListing(listingId, reason);
    res.json(listing);
  });

  // Get pending approvals for company
  router.get("/companies/:companyId/rt2/marketplace/pending-approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const listings = await svc.getPendingApprovals(companyId);
    res.json(listings);
  });

  // ===== BYOA Routes =====

  router.get("/companies/:companyId/rt2/byoa/agents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const agents = await svc.getCompanyByoaAgents(companyId);
    res.json(agents);
  });

  router.post("/companies/:companyId/rt2/byoa/agents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { name, adapterType, connectionConfig, capabilitiesDescription } = req.body;

    if (!name || !adapterType || !connectionConfig) {
      throw badRequest("name, adapterType, and connectionConfig are required");
    }

    const agent = await svc.registerByoaAgent(companyId, name, adapterType, connectionConfig, capabilitiesDescription);
    res.json(agent);
  });

  router.patch("/companies/:companyId/rt2/byoa/agents/:agentId/status", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { agentId } = req.params;
    const { isConnected } = req.body;

    if (typeof isConnected !== "boolean") {
      throw badRequest("isConnected must be a boolean");
    }

    const agent = await svc.updateByoaConnectionStatus(agentId, isConnected);
    res.json(agent);
  });

  // ===== Subscription Routes =====

  router.get("/companies/:companyId/rt2/subscriptions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const subs = await svc.getCompanySubscriptions(companyId);
    res.json(subs);
  });

  router.post("/companies/:companyId/rt2/subscriptions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { marketplaceListingId, subscriptionType, monthlyRateCents, tasksIncluded, trialDays } = req.body;

    if (!marketplaceListingId || !subscriptionType) {
      throw badRequest("marketplaceListingId and subscriptionType are required");
    }

    if (!["monthly", "per_task", "one_time"].includes(subscriptionType)) {
      throw badRequest("Invalid subscriptionType");
    }

    const sub = await svc.subscribeToAgent(companyId, marketplaceListingId, subscriptionType, {
      monthlyRateCents,
      tasksIncluded,
      trialDays,
    });

    res.json(sub);
  });

  router.post("/companies/:companyId/rt2/subscriptions/:subscriptionId/cancel", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { subscriptionId } = req.params;

    const sub = await svc.cancelSubscription(subscriptionId);
    res.json(sub);
  });

  router.post("/companies/:companyId/rt2/subscriptions/:subscriptionId/record-usage", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { subscriptionId } = req.params;

    await svc.recordTaskUsage(subscriptionId);
    res.json({ success: true });
  });

  return router;
}
