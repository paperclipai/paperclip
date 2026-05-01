import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { rt2StoreOperationsService } from "../services/rt2-store-operations.js";
import { assertCompanyAccess } from "./authz.js";

export function rt2StoreOperationsRoutes(db: Db) {
  const router = Router();
  const svc = rt2StoreOperationsService(db);

  // STORE-01: Create store listing
  // POST /api/companies/:companyId/rt2/store/listings
  router.post("/companies/:companyId/rt2/store/listings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const { projectId, storeType, storeAppId, storeUrl, appName, appDescription, category, tags, metadata } = req.body;
      if (!storeType) {
        return res.status(400).json({ error: "storeType is required" });
      }
      const listing = await svc.createStoreListing(companyId, {
        projectId,
        storeType,
        storeAppId,
        storeUrl,
        appName,
        appDescription,
        category,
        tags,
        metadata,
        actorId: req.body.actorId ?? "system",
        actorType: req.body.actorType ?? "system",
      });
      res.status(201).json({ data: listing });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // STORE-01: List store listings
  // GET /api/companies/:companyId/rt2/store/listings
  router.get("/companies/:companyId/rt2/store/listings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const { listingStatus, storeType, limit } = req.query;
      const listings = await svc.getStoreListings(companyId, {
        listingStatus: listingStatus as string | undefined,
        storeType: storeType as string | undefined,
        limit: limit ? parseInt(limit as string) : undefined,
      });
      res.json({ data: listings });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // STORE-01: Get single store listing
  // GET /api/companies/:companyId/rt2/store/listings/:listingId
  router.get("/companies/:companyId/rt2/store/listings/:listingId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const listing = await svc.getStoreListing(companyId, req.params.listingId);
      if (!listing) {
        return res.status(404).json({ error: "Listing not found" });
      }
      res.json({ data: listing });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // STORE-01: Update store listing
  // PATCH /api/companies/:companyId/rt2/store/listings/:listingId
  router.patch("/companies/:companyId/rt2/store/listings/:listingId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const { appName, appDescription, category, tags, metadata, storeUrl } = req.body;
      const listing = await svc.updateStoreListing(companyId, req.params.listingId, {
        appName,
        appDescription,
        category,
        tags,
        metadata,
        storeUrl,
        actorId: req.body.actorId ?? "system",
        actorType: req.body.actorType ?? "system",
      });
      if (!listing) {
        return res.status(404).json({ error: "Listing not found" });
      }
      res.json({ data: listing });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // STORE-01: Submit listing for review
  // POST /api/companies/:companyId/rt2/store/listings/:listingId/submit
  router.post("/companies/:companyId/rt2/store/listings/:listingId/submit", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const listing = await svc.submitForReview(companyId, req.params.listingId, {
        actorId: req.body.actorId ?? "system",
        actorType: req.body.actorType ?? "system",
      });
      if (!listing) {
        return res.status(404).json({ error: "Listing not found" });
      }
      res.json({ data: listing });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // STORE-01: Update review status (from store/reviewer)
  // POST /api/companies/:companyId/rt2/store/listings/:listingId/review-status
  router.post("/companies/:companyId/rt2/store/listings/:listingId/review-status", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const { listingStatus, latestReviewerComment, currentReviewStatus } = req.body;
      const listing = await svc.updateReviewStatus(companyId, req.params.listingId, {
        listingStatus,
        latestReviewerComment,
        latestReviewerCommentAt: latestReviewerComment ? new Date() : undefined,
        currentReviewStatus,
        actorId: req.body.actorId ?? "system",
        actorType: req.body.actorType ?? "system",
      });
      if (!listing) {
        return res.status(404).json({ error: "Listing not found" });
      }
      res.json({ data: listing });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // STORE-02: Create reviewer communication thread
  // POST /api/companies/:companyId/rt2/store/listings/:listingId/communications
  router.post("/companies/:companyId/rt2/store/listings/:listingId/communications", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const { threadSubject, initialMessage, senderType, senderActorId } = req.body;
      if (!threadSubject || !initialMessage) {
        return res.status(400).json({ error: "threadSubject and initialMessage are required" });
      }
      const communication = await svc.createReviewerCommunication(companyId, req.params.listingId, {
        threadSubject,
        initialMessage,
        senderType: senderType ?? "developer",
        senderActorId,
      });
      res.status(201).json({ data: communication });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // STORE-02: List reviewer communications for a listing
  // GET /api/companies/:companyId/rt2/store/listings/:listingId/communications
  router.get("/companies/:companyId/rt2/store/listings/:listingId/communications", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const { threadStatus, limit } = req.query;
      const communications = await svc.getReviewerCommunications(companyId, req.params.listingId, {
        threadStatus: threadStatus as string | undefined,
        limit: limit ? parseInt(limit as string) : undefined,
      });
      res.json({ data: communications });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // STORE-02: Add message to communication thread
  // POST /api/companies/:companyId/rt2/store/communications/:communicationId/messages
  router.post("/companies/:companyId/rt2/store/communications/:communicationId/messages", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const { senderType, senderActorId, messageContent, messageType } = req.body;
      if (!senderType || !messageContent) {
        return res.status(400).json({ error: "senderType and messageContent are required" });
      }
      // Get the communication to find the listingId
      const communications = await svc.getReviewerCommunications(companyId, "", { limit: 1 });
      const communicationId = req.params.communicationId;

      // Get listingId from the communication
      const { rt2StoreReviewerCommunications } = await import("@paperclipai/db");
      const { and, eq } = await import("drizzle-orm");
      const [comm] = await db
        .select()
        .from(rt2StoreReviewerCommunications)
        .where(and(
          eq(rt2StoreReviewerCommunications.id, communicationId),
          eq(rt2StoreReviewerCommunications.companyId, companyId),
        ))
        .limit(1);

      if (!comm) {
        return res.status(404).json({ error: "Communication not found" });
      }

      const message = await svc.addReviewerMessage(companyId, comm.storeListingId, communicationId, {
        senderType,
        senderActorId,
        messageContent,
        messageType,
      });
      res.status(201).json({ data: message });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // STORE-02: Get messages for a communication thread
  // GET /api/companies/:companyId/rt2/store/communications/:communicationId/messages
  router.get("/companies/:companyId/rt2/store/communications/:communicationId/messages", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const { limit } = req.query;
      const messages = await svc.getCommunicationMessages(companyId, req.params.communicationId, {
        limit: limit ? parseInt(limit as string) : undefined,
      });
      res.json({ data: messages });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // STORE-02: Resolve/close communication thread
  // POST /api/companies/:companyId/rt2/store/communications/:communicationId/resolve
  router.post("/companies/:companyId/rt2/store/communications/:communicationId/resolve", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const communication = await svc.resolveReviewerCommunication(companyId, req.params.communicationId, {
        actorId: req.body.actorId ?? "system",
        actorType: req.body.actorType ?? "system",
      });
      if (!communication) {
        return res.status(404).json({ error: "Communication not found" });
      }
      res.json({ data: communication });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // STORE-02: Get store audit trails
  // GET /api/companies/:companyId/rt2/store/audit-trails
  router.get("/companies/:companyId/rt2/store/audit-trails", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const { storeListingId, action, limit } = req.query;
      const trails = await svc.getStoreAuditTrails(companyId, {
        storeListingId: storeListingId as string | undefined,
        action: action as string | undefined,
        limit: limit ? parseInt(limit as string) : undefined,
      });
      res.json({ data: trails });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  return router;
}
