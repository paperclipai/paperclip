import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  rt2StoreAuditTrails,
  rt2StoreListings,
  rt2StoreReviewerCommunications,
  rt2StoreReviewerMessages,
} from "@paperclipai/db";

export type StoreListing = {
  id: string;
  companyId: string;
  projectId: string | null;
  storeType: string;
  listingStatus: string;
  storeAppId: string | null;
  storeUrl: string | null;
  appName: string | null;
  appDescription: string | null;
  category: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  latestReviewerComment: string | null;
  latestReviewerCommentAt: Date | null;
  currentReviewStatus: string | null;
  submittedAt: Date | null;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function rt2StoreOperationsService(db: Db) {
  // STORE-01: Create a store listing
  async function createStoreListing(
    companyId: string,
    input: {
      projectId?: string;
      storeType: string;
      storeAppId?: string;
      storeUrl?: string;
      appName?: string;
      appDescription?: string;
      category?: string;
      tags?: string[];
      metadata?: Record<string, unknown>;
      actorId?: string;
      actorType?: string;
    },
  ) {
    const [listing] = await db
      .insert(rt2StoreListings)
      .values({
        companyId,
        projectId: input.projectId ?? null,
        storeType: input.storeType,
        listingStatus: "draft",
        storeAppId: input.storeAppId ?? null,
        storeUrl: input.storeUrl ?? null,
        appName: input.appName ?? null,
        appDescription: input.appDescription ?? null,
        category: input.category ?? null,
        tags: input.tags ?? [],
        metadata: input.metadata ?? {},
      })
      .returning();

    // Audit trail
    await db.insert(activityLog).values({
      companyId,
      actorId: input.actorId ?? "system",
      actorType: input.actorType ?? "system",
      action: "rt2.store.listing_created",
      entityType: "store_listing",
      entityId: listing.id,
      details: { storeType: input.storeType, appName: input.appName },
    });

    await db.insert(rt2StoreAuditTrails).values({
      companyId,
      storeListingId: listing.id,
      action: "listing_created",
      actorType: input.actorType ?? "system",
      actorId: input.actorId ?? "system",
      entityType: "store_listing",
      entityId: listing.id,
      details: { storeType: input.storeType, appName: input.appName },
    });

    return listing as unknown as StoreListing;
  }

  // STORE-01: Update store listing metadata
  async function updateStoreListing(
    companyId: string,
    listingId: string,
    input: {
      appName?: string;
      appDescription?: string;
      category?: string;
      tags?: string[];
      metadata?: Record<string, unknown>;
      storeUrl?: string;
      actorId?: string;
      actorType?: string;
    },
  ) {
    const [listing] = await db
      .update(rt2StoreListings)
      .set({
        appName: input.appName,
        appDescription: input.appDescription,
        category: input.category,
        tags: input.tags,
        metadata: input.metadata,
        storeUrl: input.storeUrl,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(rt2StoreListings.id, listingId),
          eq(rt2StoreListings.companyId, companyId),
        ),
      )
      .returning();

    if (!listing) return null;

    // Audit trail
    await db.insert(rt2StoreAuditTrails).values({
      companyId,
      storeListingId: listingId,
      action: "listing_updated",
      actorType: input.actorType ?? "system",
      actorId: input.actorId ?? "system",
      entityType: "store_listing",
      entityId: listingId,
      details: { updatedFields: Object.keys(input) },
    });

    return listing as unknown as StoreListing;
  }

  // STORE-01: Submit listing for review
  async function submitForReview(
    companyId: string,
    listingId: string,
    input: {
      actorId?: string;
      actorType?: string;
    },
  ) {
    const [listing] = await db
      .update(rt2StoreListings)
      .set({
        listingStatus: "pending_review",
        submittedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(rt2StoreListings.id, listingId),
          eq(rt2StoreListings.companyId, companyId),
        ),
      )
      .returning();

    if (!listing) return null;

    // Audit trail
    await db.insert(rt2StoreAuditTrails).values({
      companyId,
      storeListingId: listingId,
      action: "submitted_for_review",
      actorType: input.actorType ?? "system",
      actorId: input.actorId ?? "system",
      entityType: "store_listing",
      entityId: listingId,
      details: {},
    });

    return listing as unknown as StoreListing;
  }

  // STORE-01: Update review status (from reviewer comment)
  async function updateReviewStatus(
    companyId: string,
    listingId: string,
    input: {
      listingStatus?: string;
      latestReviewerComment?: string;
      latestReviewerCommentAt?: Date;
      currentReviewStatus?: string;
      actorId?: string;
      actorType?: string;
    },
  ) {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.listingStatus) updates.listingStatus = input.listingStatus;
    if (input.latestReviewerComment) {
      updates.latestReviewerComment = input.latestReviewerComment;
      updates.latestReviewerCommentAt = input.latestReviewerCommentAt ?? new Date();
    }
    if (input.currentReviewStatus) updates.currentReviewStatus = input.currentReviewStatus;
    if (input.listingStatus === "approved") updates.approvedAt = new Date();
    if (input.listingStatus === "rejected") updates.rejectedAt = new Date();

    const [listing] = await db
      .update(rt2StoreListings)
      .set(updates)
      .where(
        and(
          eq(rt2StoreListings.id, listingId),
          eq(rt2StoreListings.companyId, companyId),
        ),
      )
      .returning();

    if (!listing) return null;

    // Audit trail
    await db.insert(rt2StoreAuditTrails).values({
      companyId,
      storeListingId: listingId,
      action: "status_changed",
      actorType: input.actorType ?? "system",
      actorId: input.actorId ?? "system",
      entityType: "store_listing",
      entityId: listingId,
      details: {
        newStatus: input.listingStatus,
        reviewerComment: input.latestReviewerComment ? true : false,
      },
    });

    return listing as unknown as StoreListing;
  }

  // STORE-01: Get store listings
  async function getStoreListings(
    companyId: string,
    options?: {
      listingStatus?: string;
      storeType?: string;
      limit?: number;
    },
  ) {
    const conditions = [eq(rt2StoreListings.companyId, companyId)];
    if (options?.listingStatus) {
      conditions.push(eq(rt2StoreListings.listingStatus, options.listingStatus));
    }
    if (options?.storeType) {
      conditions.push(eq(rt2StoreListings.storeType, options.storeType));
    }

    return db
      .select()
      .from(rt2StoreListings)
      .where(and(...conditions))
      .orderBy(desc(rt2StoreListings.updatedAt))
      .limit(options?.limit ?? 50);
  }

  // STORE-01: Get single store listing
  async function getStoreListing(companyId: string, listingId: string) {
    const [listing] = await db
      .select()
      .from(rt2StoreListings)
      .where(
        and(
          eq(rt2StoreListings.id, listingId),
          eq(rt2StoreListings.companyId, companyId),
        ),
      )
      .limit(1);
    return listing as unknown as StoreListing | null;
  }

  // STORE-02: Create reviewer communication thread
  async function createReviewerCommunication(
    companyId: string,
    listingId: string,
    input: {
      threadSubject: string;
      initialMessage: string;
      senderType?: string;
      senderActorId?: string;
    },
  ) {
    const [communication] = await db
      .insert(rt2StoreReviewerCommunications)
      .values({
        companyId,
        storeListingId: listingId,
        threadSubject: input.threadSubject,
        threadStatus: "open",
        lastMessageAt: new Date(),
        lastMessageBy: input.senderType ?? "developer",
      })
      .returning();

    // Insert the initial message
    await db.insert(rt2StoreReviewerMessages).values({
      companyId,
      storeListingId: listingId,
      communicationId: communication.id,
      senderType: input.senderType ?? "developer",
      senderActorId: input.senderActorId,
      messageContent: input.initialMessage,
      messageType: "text",
    });

    // Audit trail
    await db.insert(rt2StoreAuditTrails).values({
      companyId,
      storeListingId: listingId,
      action: "reviewer_message_sent",
      actorType: input.senderType ?? "developer",
      actorId: input.senderActorId ?? "system",
      entityType: "reviewer_communication",
      entityId: communication.id,
      details: { threadSubject: input.threadSubject },
    });

    return communication;
  }

  // STORE-02: Add message to reviewer communication thread
  async function addReviewerMessage(
    companyId: string,
    listingId: string,
    communicationId: string,
    input: {
      senderType: string;
      senderActorId?: string;
      messageContent: string;
      messageType?: string;
    },
  ) {
    const [message] = await db
      .insert(rt2StoreReviewerMessages)
      .values({
        companyId,
        storeListingId: listingId,
        communicationId,
        senderType: input.senderType,
        senderActorId: input.senderActorId,
        messageContent: input.messageContent,
        messageType: input.messageType ?? "text",
      })
      .returning();

    // Update thread status
    await db
      .update(rt2StoreReviewerCommunications)
      .set({
        lastMessageAt: new Date(),
        lastMessageBy: input.senderType,
        threadStatus: input.senderType === "reviewer" ? "responded" : "awaiting_response",
        updatedAt: new Date(),
      })
      .where(eq(rt2StoreReviewerCommunications.id, communicationId));

    // Audit trail
    await db.insert(rt2StoreAuditTrails).values({
      companyId,
      storeListingId: listingId,
      action: input.senderType === "reviewer" ? "reviewer_message_received" : "reviewer_message_sent",
      actorType: input.senderType,
      actorId: input.senderActorId ?? "system",
      entityType: "reviewer_message",
      entityId: message.id,
      details: { communicationId },
    });

    return message;
  }

  // STORE-02: Get reviewer communications for a listing
  async function getReviewerCommunications(
    companyId: string,
    listingId: string,
    options?: { threadStatus?: string; limit?: number },
  ) {
    const conditions = [
      eq(rt2StoreReviewerCommunications.companyId, companyId),
      eq(rt2StoreReviewerCommunications.storeListingId, listingId),
    ];
    if (options?.threadStatus) {
      conditions.push(eq(rt2StoreReviewerCommunications.threadStatus, options.threadStatus));
    }

    return db
      .select()
      .from(rt2StoreReviewerCommunications)
      .where(and(...conditions))
      .orderBy(desc(rt2StoreReviewerCommunications.lastMessageAt))
      .limit(options?.limit ?? 50);
  }

  // STORE-02: Get messages for a communication thread
  async function getCommunicationMessages(
    companyId: string,
    communicationId: string,
    options?: { limit?: number },
  ) {
    return db
      .select()
      .from(rt2StoreReviewerMessages)
      .where(eq(rt2StoreReviewerMessages.communicationId, communicationId))
      .orderBy(desc(rt2StoreReviewerMessages.createdAt))
      .limit(options?.limit ?? 100);
  }

  // STORE-02: Resolve/close reviewer communication thread
  async function resolveReviewerCommunication(
    companyId: string,
    communicationId: string,
    input: {
      actorId?: string;
      actorType?: string;
    },
  ) {
    const [communication] = await db
      .update(rt2StoreReviewerCommunications)
      .set({
        threadStatus: "resolved",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(rt2StoreReviewerCommunications.id, communicationId),
          eq(rt2StoreReviewerCommunications.companyId, companyId),
        ),
      )
      .returning();

    if (!communication) return null;

    // Audit trail
    await db.insert(rt2StoreAuditTrails).values({
      companyId,
      storeListingId: communication.storeListingId,
      action: "thread_resolved",
      actorType: input.actorType ?? "system",
      actorId: input.actorId ?? "system",
      entityType: "reviewer_communication",
      entityId: communicationId,
      details: {},
    });

    return communication;
  }

  // STORE-02: Get store audit trails
  async function getStoreAuditTrails(
    companyId: string,
    options?: {
      storeListingId?: string;
      action?: string;
      limit?: number;
    },
  ) {
    const conditions = [eq(rt2StoreAuditTrails.companyId, companyId)];
    if (options?.storeListingId) {
      conditions.push(eq(rt2StoreAuditTrails.storeListingId, options.storeListingId));
    }
    if (options?.action) {
      conditions.push(eq(rt2StoreAuditTrails.action, options.action));
    }

    return db
      .select()
      .from(rt2StoreAuditTrails)
      .where(and(...conditions))
      .orderBy(desc(rt2StoreAuditTrails.createdAt))
      .limit(options?.limit ?? 100);
  }

  return {
    createStoreListing,
    updateStoreListing,
    submitForReview,
    updateReviewStatus,
    getStoreListings,
    getStoreListing,
    createReviewerCommunication,
    addReviewerMessage,
    getReviewerCommunications,
    getCommunicationMessages,
    resolveReviewerCommunication,
    getStoreAuditTrails,
  };
}
