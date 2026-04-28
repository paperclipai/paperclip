import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { rt2AgentMarketplaceService } from "../services/rt2-agent-marketplace.js";
import { assertCompanyAccess } from "./authz.js";
import { badRequest } from "../errors.js";

export function rt2AgentMarketplaceRoutes(db: Db) {
  const router = Router();
  const svc = rt2AgentMarketplaceService(db);

  // M3.2: List marketplace agents
  router.get("/rt2/marketplace/agents", async (req, res) => {
    const category = req.query.category as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

    const agents = await svc.listMarketplaceAgents(category, limit, offset);
    res.json(agents);
  });

  router.get("/companies/:companyId/rt2/marketplace/agents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const category = req.query.category as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

    const agents = await svc.listCompanyMarketplaceAgents(companyId, category, limit, offset);
    res.json(agents);
  });

  // M3.2: Search marketplace agents
  router.get("/rt2/marketplace/search", async (req, res) => {
    const query = req.query.q as string;
    const category = req.query.category as string | undefined;

    if (!query) {
      throw badRequest("Search query 'q' is required");
    }

    const agents = await svc.searchMarketplaceAgents(query, category);
    res.json(agents);
  });

  // M3.2: Get marketplace listing
  router.get("/rt2/marketplace/agents/:listingId", async (req, res) => {
    const { listingId } = req.params;

    const listing = await svc.getMarketplaceListing(listingId);
    if (!listing) {
      throw badRequest("Listing not found");
    }

    res.json(listing);
  });

  // M3.2: Create marketplace listing (for creators)
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

  // M3.2: Get BYOA agents for company
  router.get("/companies/:companyId/rt2/byoa/agents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const agents = await svc.getCompanyByoaAgents(companyId);
    res.json(agents);
  });

  // M3.2: Register BYOA agent
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

  // M3.2: Update BYOA connection status
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

  // M3.2: Get company subscriptions
  router.get("/companies/:companyId/rt2/subscriptions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const subs = await svc.getCompanySubscriptions(companyId);
    res.json(subs);
  });

  // M3.2: Subscribe to marketplace agent
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

  // M3.2: Cancel subscription
  router.post("/companies/:companyId/rt2/subscriptions/:subscriptionId/cancel", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { subscriptionId } = req.params;

    const sub = await svc.cancelSubscription(subscriptionId);
    res.json(sub);
  });

  // M3.2: Record task usage
  router.post("/companies/:companyId/rt2/subscriptions/:subscriptionId/record-usage", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { subscriptionId } = req.params;

    await svc.recordTaskUsage(subscriptionId);
    res.json({ success: true });
  });

  return router;
}
