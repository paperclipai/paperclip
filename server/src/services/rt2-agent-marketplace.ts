import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issueWorkProducts,
  rt2AgentMarketplace,
  rt2AgentSubscriptions,
  rt2ByoaAgents,
  rt2CollaborationRewards,
  rt2QualityScores,
} from "@paperclipai/db";

export type MarketplaceListing = {
  id: string;
  creatorCompanyId: string;
  name: string;
  description: string | null;
  category: string;
  tags: string[] | null;
  pricingType: string;
  pricePerTaskCents: number | null;
  monthlySubscriptionCents: number | null;
  capabilities: string;
  adapterType: string;
  isActive: boolean;
  totalSubscriptions: number;
  ratingAverage: number;
  ratingCount: number;
  listingApprovalStatus: "draft" | "pending_approval" | "approved" | "rejected";
  rejectionReason: string | null;
  submittedAt: Date | null;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  evidence?: MarketplaceListingEvidence;
};

export type MarketplaceListingEvidence = {
  skills: string[];
  deliverableCount: number;
  approvedDeliverableCount: number;
  averageQualityScore: number | null;
  approvedBasePriceGold: number;
  earnedGoldEstimate: number;
  reputationIndex: number | null;
  collaborationMultiplier: number | null;
  subscriptionCount: number;
  evidenceStatus: "ready" | "partial" | "missing";
  calculationBasis: string[];
  latestApprovedDeliverables: Array<{
    workProductId: string;
    title: string;
    type: string;
    basePriceGold: number;
    qualityScore: number;
    earnedGold: number;
  }>;
  pricing: {
    pricingType: string;
    pricePerTaskCents: number | null;
    monthlySubscriptionCents: number | null;
  };
};

export type ListingApprovalStatus = "draft" | "pending_approval" | "approved" | "rejected";

export type EvidenceTier = "bronze" | "silver" | "gold";
export type ReputationTier = "new" | "established" | "top_rated";
export type QualityTier = "bronze" | "silver" | "gold";

export type PublicListingEvidence = {
  evidenceTier: EvidenceTier;
  reputationTier: ReputationTier;
  qualityTier: QualityTier;
  evidenceStatus: "ready" | "partial" | "missing";
  pricingSummary: {
    pricingType: string;
    priceLabel: string;
  };
  approvalStatus: ListingApprovalStatus;
};

export type PublicMarketplaceListing = {
  id: string;
  creatorCompanyId: string;
  name: string;
  description: string | null;
  category: string;
  tags: string[] | null;
  pricingType: string;
  pricePerTaskCents: number | null;
  monthlySubscriptionCents: number | null;
  adapterType: string;
  isActive: boolean;
  totalSubscriptions: number;
  ratingAverage: number;
  ratingCount: number;
  publicEvidence: PublicListingEvidence;
};

export type ByoaAgent = {
  id: string;
  companyId: string;
  name: string;
  adapterType: string;
  connectionConfig: string;
  capabilitiesDescription: string | null;
  isConnected: boolean;
  lastConnectedAt: Date | null;
  monthlyBudgetCents: number;
  spentCents: number;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentSubscription = {
  id: string;
  companyId: string;
  marketplaceListingId: string;
  subscriptionType: string;
  status: string;
  monthlyRateCents: number | null;
  tasksIncluded: number | null;
  tasksUsed: number;
  trialEndsAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  createdAt: Date;
  updatedAt: Date;
  cancelledAt: Date | null;
};

export function rt2AgentMarketplaceService(db: Db) {
  // ===== Marketplace Listings =====

  /**
   * M3.2: List marketplace agents
   */
  async function listMarketplaceAgents(
    category?: string,
    limit: number = 20,
    offset: number = 0,
    options?: { publicOnly?: boolean; companyId?: string },
  ): Promise<MarketplaceListing[]> {
    const conditions = [eq(rt2AgentMarketplace.isActive, true)];
    if (category) {
      conditions.push(eq(rt2AgentMarketplace.category, category));
    }
    // Public view: only approved listings
    if (options?.publicOnly) {
      conditions.push(eq(rt2AgentMarketplace.listingApprovalStatus, "approved"));
    }

    const listings = await db
      .select()
      .from(rt2AgentMarketplace)
      .where(and(...conditions))
      .orderBy(desc(rt2AgentMarketplace.ratingAverage))
      .limit(limit)
      .offset(offset);

    // If companyId provided, include own listings even if not approved
    if (options?.companyId) {
      const ownListings = await db
        .select()
        .from(rt2AgentMarketplace)
        .where(
          and(
            eq(rt2AgentMarketplace.isActive, true),
            eq(rt2AgentMarketplace.creatorCompanyId, options.companyId!),
          ),
        )
        .orderBy(desc(rt2AgentMarketplace.ratingAverage));
      const ownIds = new Set(ownListings.map((l) => l.id));
      const combined = listings.concat(ownListings.filter((l) => !ownIds.has(l.id)));
      return Promise.all(combined.map((listing) => mapListingWithEvidence(listing)));
    }

    return Promise.all(listings.map((listing) => mapListingWithEvidence(listing)));
  }

  async function listCompanyMarketplaceAgents(
    companyId: string,
    category?: string,
    limit: number = 20,
    offset: number = 0,
  ): Promise<MarketplaceListing[]> {
    const conditions = [
      eq(rt2AgentMarketplace.isActive, true),
      eq(rt2AgentMarketplace.creatorCompanyId, companyId),
    ];
    if (category) {
      conditions.push(eq(rt2AgentMarketplace.category, category));
    }

    const listings = await db
      .select()
      .from(rt2AgentMarketplace)
      .where(and(...conditions))
      .orderBy(desc(rt2AgentMarketplace.ratingAverage))
      .limit(limit)
      .offset(offset);

    return Promise.all(listings.map((listing) => mapListingWithEvidence(listing)));
  }

  /**
   * M3.2: Search marketplace agents (public - only approved listings)
   */
  async function searchMarketplaceAgents(
    query: string,
    category?: string,
  ): Promise<MarketplaceListing[]> {
    const listings = await listMarketplaceAgents(category, 50, 0, { publicOnly: true });

    // Simple search filter
    const q = query.toLowerCase();
    return listings.filter(
      l =>
        l.name.toLowerCase().includes(q) ||
        (l.description?.toLowerCase().includes(q) ?? false) ||
        l.tags?.some(t => t.toLowerCase().includes(q)),
    );
  }

  /**
   * Search marketplace agents for company (includes draft/pending)
   */
  async function searchCompanyMarketplaceAgents(
    companyId: string,
    query: string,
    category?: string,
  ): Promise<MarketplaceListing[]> {
    const listings = await listMarketplaceAgents(category, 50, 0, { companyId });

    const q = query.toLowerCase();
    return listings.filter(
      l =>
        l.name.toLowerCase().includes(q) ||
        (l.description?.toLowerCase().includes(q) ?? false) ||
        l.tags?.some(t => t.toLowerCase().includes(q)),
    );
  }

  /**
   * M3.2: Get marketplace listing by ID
   */
  async function getMarketplaceListing(listingId: string): Promise<MarketplaceListing | null> {
    const [listing] = await db
      .select()
      .from(rt2AgentMarketplace)
      .where(eq(rt2AgentMarketplace.id, listingId))
      .limit(1);

    if (!listing) return null;

    return mapListingWithEvidence(listing);
  }

  async function mapListingWithEvidence(row: typeof rt2AgentMarketplace.$inferSelect): Promise<MarketplaceListing> {
    const evidence = await getListingEvidence(row);
    return {
      ...row,
      tags: row.tags as string[] | null,
      evidence,
    } as MarketplaceListing;
  }

function extractSkills(listing: typeof rt2AgentMarketplace.$inferSelect): string[] {
    const tags = Array.isArray(listing.tags) ? listing.tags.filter((tag): tag is string => typeof tag === "string") : [];
    try {
      const capabilities = JSON.parse(listing.capabilities || "{}") as { skills?: unknown; tools?: unknown };
      const skills = Array.isArray(capabilities.skills)
        ? capabilities.skills.filter((skill): skill is string => typeof skill === "string")
        : [];
      const tools = Array.isArray(capabilities.tools)
        ? capabilities.tools.filter((tool): tool is string => typeof tool === "string")
        : [];
      return Array.from(new Set([...tags, ...skills, ...tools]));
    } catch {
      return tags;
    }
  }

  function getNumberMetadata(metadata: Record<string, unknown> | null | undefined, key: string): number | null {
    const value = metadata?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  async function getListingEvidence(
    listing: typeof rt2AgentMarketplace.$inferSelect,
  ): Promise<MarketplaceListingEvidence> {
    const skillTerms = extractSkills(listing).map((term) => term.toLowerCase());
    const deliverables = await db
      .select({
        id: issueWorkProducts.id,
        issueId: issueWorkProducts.issueId,
        type: issueWorkProducts.type,
        title: issueWorkProducts.title,
        summary: issueWorkProducts.summary,
        metadata: issueWorkProducts.metadata,
      })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.companyId, listing.creatorCompanyId));

    const matchingDeliverables = deliverables.filter((deliverable) => {
      const haystack = `${deliverable.type} ${deliverable.title} ${deliverable.summary ?? ""}`.toLowerCase();
      return (
        haystack.includes(listing.category.toLowerCase()) ||
        skillTerms.length === 0 ||
        skillTerms.some((term) => haystack.includes(term))
      );
    });

    const qualityRows = await db
      .select({
        taskIssueId: rt2QualityScores.taskIssueId,
        score: rt2QualityScores.score,
        basePrice: rt2QualityScores.basePrice,
        managerDecision: rt2QualityScores.managerDecision,
        isFinalized: rt2QualityScores.isFinalized,
        isActive: rt2QualityScores.isActive,
      })
      .from(rt2QualityScores)
      .where(eq(rt2QualityScores.companyId, listing.creatorCompanyId));
    const matchingTaskIds = new Set(matchingDeliverables.map((deliverable) => deliverable.issueId));
    const approvedQualityRows = qualityRows.filter(
      (row) =>
        matchingTaskIds.has(row.taskIssueId) &&
        row.managerDecision === "approved" &&
        row.isFinalized === 1 &&
        row.isActive === 1,
    );
    const approvedByTaskId = new Map(approvedQualityRows.map((row) => [row.taskIssueId, row]));
    const approvedDeliverables = matchingDeliverables
      .map((deliverable) => {
        const quality = approvedByTaskId.get(deliverable.issueId);
        if (!quality) return null;
        const basePriceGold = quality.basePrice ?? getNumberMetadata(deliverable.metadata, "rt2BasePrice") ?? quality.score;
        return {
          workProductId: deliverable.id,
          title: deliverable.title,
          type: deliverable.type,
          basePriceGold,
          qualityScore: quality.score,
          earnedGold: Math.max(0, Math.round(basePriceGold)),
        };
      })
      .filter((deliverable): deliverable is NonNullable<typeof deliverable> => deliverable !== null);
    const reward = await db
      .select()
      .from(rt2CollaborationRewards)
      .where(
        and(
          eq(rt2CollaborationRewards.companyId, listing.creatorCompanyId),
          eq(rt2CollaborationRewards.actorId, listing.id),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const subscriptionCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(rt2AgentSubscriptions)
      .where(eq(rt2AgentSubscriptions.marketplaceListingId, listing.id))
      .then((rows) => rows[0]?.count ?? 0);
    const approvedBasePriceGold = approvedDeliverables.reduce((sum, deliverable) => sum + deliverable.basePriceGold, 0);
    const earnedGoldEstimate = approvedDeliverables.reduce((sum, deliverable) => sum + deliverable.earnedGold, 0);
    const evidenceStatus =
      approvedDeliverables.length > 0 && reward
        ? "ready"
        : approvedDeliverables.length > 0 || reward || subscriptionCount > 0
          ? "partial"
          : "missing";

    return {
      skills: extractSkills(listing),
      deliverableCount: matchingDeliverables.length,
      approvedDeliverableCount: approvedDeliverables.length,
      averageQualityScore:
        approvedQualityRows.length > 0
          ? Math.round(approvedQualityRows.reduce((sum, row) => sum + row.score, 0) / approvedQualityRows.length)
          : null,
      approvedBasePriceGold,
      earnedGoldEstimate,
      reputationIndex: reward?.reputationIndex ?? null,
      collaborationMultiplier: reward?.multiplier ?? null,
      subscriptionCount,
      evidenceStatus,
      calculationBasis: [
        "matching deliverables from issue_work_products",
        "approved quality scores from rt2_quality_scores",
        "reputation and collaboration multiplier from rt2_collaboration_rewards",
        "usage demand from rt2_agent_subscriptions",
      ],
      latestApprovedDeliverables: approvedDeliverables.slice(0, 3),
      pricing: {
        pricingType: listing.pricingType,
        pricePerTaskCents: listing.pricePerTaskCents,
        monthlySubscriptionCents: listing.monthlySubscriptionCents,
      },
    };
  }

  /**
   * M3.2: Create marketplace listing
   */
  async function createListing(
    creatorCompanyId: string,
    name: string,
    category: string,
    adapterType: string,
    options?: {
      description?: string;
      tags?: string[];
      pricingType?: string;
      pricePerTaskCents?: number;
      monthlySubscriptionCents?: number;
      capabilities?: string;
    },
  ): Promise<MarketplaceListing> {
    const [listing] = await db
      .insert(rt2AgentMarketplace)
      .values({
        creatorCompanyId,
        name,
        category,
        adapterType,
        description: options?.description || null,
        tags: options?.tags || null,
        pricingType: options?.pricingType || "per_task",
        pricePerTaskCents: options?.pricePerTaskCents || null,
        monthlySubscriptionCents: options?.monthlySubscriptionCents || null,
        capabilities: options?.capabilities || "{}",
        listingApprovalStatus: "draft",
      })
      .returning();

    return {
      ...listing,
      tags: listing.tags as string[] | null,
    } as MarketplaceListing;
  }

  // ===== BYOA =====

  /**
   * M3.2: Register external agent (BYOA)
   */
  async function registerByoaAgent(
    companyId: string,
    name: string,
    adapterType: string,
    connectionConfig: string,
    capabilitiesDescription?: string,
  ): Promise<ByoaAgent> {
    const [agent] = await db
      .insert(rt2ByoaAgents)
      .values({
        companyId,
        name,
        adapterType,
        connectionConfig,
        capabilitiesDescription,
      })
      .returning();

    return agent as unknown as ByoaAgent;
  }

  /**
   * M3.2: Get company's BYOA agents
   */
  async function getCompanyByoaAgents(companyId: string): Promise<ByoaAgent[]> {
    const agents = await db
      .select()
      .from(rt2ByoaAgents)
      .where(eq(rt2ByoaAgents.companyId, companyId))
      .orderBy(desc(rt2ByoaAgents.createdAt));

    return agents as unknown as ByoaAgent[];
  }

  /**
   * M3.2: Update BYOA agent connection status
   */
  async function updateByoaConnectionStatus(
    agentId: string,
    isConnected: boolean,
  ): Promise<ByoaAgent> {
    const [updated] = await db
      .update(rt2ByoaAgents)
      .set({
        isConnected,
        lastConnectedAt: isConnected ? new Date() : undefined,
        updatedAt: new Date(),
      })
      .where(eq(rt2ByoaAgents.id, agentId))
      .returning();

    return updated as unknown as ByoaAgent;
  }

  // ===== Subscriptions =====

  /**
   * M3.2: Subscribe to marketplace agent
   */
  async function subscribeToAgent(
    companyId: string,
    marketplaceListingId: string,
    subscriptionType: "monthly" | "per_task" | "one_time",
    options?: {
      monthlyRateCents?: number;
      tasksIncluded?: number;
      trialDays?: number;
    },
  ): Promise<AgentSubscription> {
    const now = new Date();
    const periodEnd = new Date(now);
    if (subscriptionType === "monthly") {
      periodEnd.setMonth(periodEnd.getMonth() + 1);
    }

    const [sub] = await db
      .insert(rt2AgentSubscriptions)
      .values({
        companyId,
        marketplaceListingId,
        subscriptionType,
        status: options?.trialDays ? "trial" : "active",
        monthlyRateCents: options?.monthlyRateCents || null,
        tasksIncluded: options?.tasksIncluded || null,
        trialEndsAt: options?.trialDays
          ? new Date(now.getTime() + options.trialDays * 24 * 60 * 60 * 1000)
          : null,
        currentPeriodStart: now,
        currentPeriodEnd: subscriptionType === "monthly" ? periodEnd : null,
      })
      .returning();

    // Increment subscription count on listing
    await db
      .update(rt2AgentMarketplace)
      .set({
        totalSubscriptions: sql`${rt2AgentMarketplace.totalSubscriptions} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(rt2AgentMarketplace.id, marketplaceListingId));

    return sub as unknown as AgentSubscription;
  }

  /**
   * M3.2: Get company's subscriptions
   */
  async function getCompanySubscriptions(companyId: string): Promise<AgentSubscription[]> {
    const subs = await db
      .select()
      .from(rt2AgentSubscriptions)
      .where(eq(rt2AgentSubscriptions.companyId, companyId))
      .orderBy(desc(rt2AgentSubscriptions.createdAt));

    return subs as unknown as AgentSubscription[];
  }

  /**
   * M3.2: Cancel subscription
   */
  async function cancelSubscription(subscriptionId: string): Promise<AgentSubscription> {
    const [updated] = await db
      .update(rt2AgentSubscriptions)
      .set({
        status: "cancelled",
        cancelledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(rt2AgentSubscriptions.id, subscriptionId))
      .returning();

    return updated as unknown as AgentSubscription;
  }

  /**
   * M3.2: Record task usage
   */
  async function recordTaskUsage(subscriptionId: string): Promise<void> {
    await db
      .update(rt2AgentSubscriptions)
      .set({
        tasksUsed: sql`${rt2AgentSubscriptions.tasksUsed} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(rt2AgentSubscriptions.id, subscriptionId));
  }

  /**
   * M3.2: Get subscription by marketplace listing (for a company)
   */
  async function getActiveSubscription(
    companyId: string,
    marketplaceListingId: string,
  ): Promise<AgentSubscription | null> {
    const [sub] = await db
      .select()
      .from(rt2AgentSubscriptions)
      .where(
        and(
          eq(rt2AgentSubscriptions.companyId, companyId),
          eq(rt2AgentSubscriptions.marketplaceListingId, marketplaceListingId),
          eq(rt2AgentSubscriptions.status, "active"),
        ),
      )
      .limit(1);

    return (sub as unknown as AgentSubscription) ?? null;
  }

  // ===== Public Marketplace (Phase 72) =====

  /**
   * Derive evidence tier bucket from approved deliverable count
   */
  function deriveEvidenceTier(approvedCount: number): EvidenceTier {
    if (approvedCount >= 6) return "gold";
    if (approvedCount >= 3) return "silver";
    return "bronze";
  }

  /**
   * Derive reputation tier from subscription count
   */
  function deriveReputationTier(subscriptionCount: number): ReputationTier {
    if (subscriptionCount >= 11) return "top_rated";
    if (subscriptionCount >= 1) return "established";
    return "new";
  }

  /**
   * Derive quality tier from average quality score
   */
  function deriveQualityTier(averageQualityScore: number | null): QualityTier {
    if (averageQualityScore === null) return "bronze";
    if (averageQualityScore >= 75) return "gold";
    if (averageQualityScore >= 50) return "silver";
    return "bronze";
  }

  /**
   * Get pricing label for public view
   */
  function getPricingLabel(
    pricingType: string,
    pricePerTaskCents: number | null,
    monthlySubscriptionCents: number | null,
  ): string {
    switch (pricingType) {
      case "subscription":
        return monthlySubscriptionCents
          ? `$${(monthlySubscriptionCents / 100).toFixed(0)}/month`
          : "Subscription";
      case "one_time":
        return pricePerTaskCents ? `$${(pricePerTaskCents / 100).toFixed(0)} one-time` : "One-time";
      default:
        return pricePerTaskCents ? `$${(pricePerTaskCents / 100).toFixed(0)}/task` : "Per task";
    }
  }

  /**
   * Submit listing for approval (draft -> pending_approval)
   */
  async function submitForApproval(
    listingId: string,
    companyId: string,
  ): Promise<MarketplaceListing> {
    const [listing] = await db
      .select()
      .from(rt2AgentMarketplace)
      .where(eq(rt2AgentMarketplace.id, listingId))
      .limit(1);

    if (!listing) throw new Error("Listing not found");
    if (listing.creatorCompanyId !== companyId) throw new Error("Not authorized");
    if (listing.listingApprovalStatus !== "draft") {
      throw new Error("Only draft listings can be submitted for approval");
    }

    const [updated] = await db
      .update(rt2AgentMarketplace)
      .set({
        listingApprovalStatus: "pending_approval",
        submittedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(rt2AgentMarketplace.id, listingId))
      .returning();

    return updated as unknown as MarketplaceListing;
  }

  /**
   * Approve listing (pending_approval -> approved)
   */
  async function approveListing(listingId: string): Promise<MarketplaceListing> {
    const [listing] = await db
      .select()
      .from(rt2AgentMarketplace)
      .where(eq(rt2AgentMarketplace.id, listingId))
      .limit(1);

    if (!listing) throw new Error("Listing not found");
    if (listing.listingApprovalStatus !== "pending_approval") {
      throw new Error("Only pending_approval listings can be approved");
    }

    const [updated] = await db
      .update(rt2AgentMarketplace)
      .set({
        listingApprovalStatus: "approved",
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(rt2AgentMarketplace.id, listingId))
      .returning();

    return updated as unknown as MarketplaceListing;
  }

  /**
   * Reject listing (pending_approval -> rejected)
   */
  async function rejectListing(
    listingId: string,
    reason: string,
  ): Promise<MarketplaceListing> {
    const [listing] = await db
      .select()
      .from(rt2AgentMarketplace)
      .where(eq(rt2AgentMarketplace.id, listingId))
      .limit(1);

    if (!listing) throw new Error("Listing not found");
    if (listing.listingApprovalStatus !== "pending_approval") {
      throw new Error("Only pending_approval listings can be rejected");
    }

    const [updated] = await db
      .update(rt2AgentMarketplace)
      .set({
        listingApprovalStatus: "rejected",
        rejectionReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(rt2AgentMarketplace.id, listingId))
      .returning();

    return updated as unknown as MarketplaceListing;
  }

  /**
   * Get pending approval listings for a company
   */
  async function getPendingApprovals(companyId: string): Promise<MarketplaceListing[]> {
    const listings = await db
      .select()
      .from(rt2AgentMarketplace)
      .where(
        and(
          eq(rt2AgentMarketplace.creatorCompanyId, companyId),
          eq(rt2AgentMarketplace.listingApprovalStatus, "pending_approval"),
        ),
      )
      .orderBy(desc(rt2AgentMarketplace.submittedAt));

    return Promise.all(listings.map((listing) => mapListingWithEvidence(listing)));
  }

  /**
   * Get public marketplace listing (public evidence contract)
   */
  async function getPublicMarketplaceListing(
    listingId: string,
  ): Promise<PublicMarketplaceListing | null> {
    const [listing] = await db
      .select()
      .from(rt2AgentMarketplace)
      .where(
        and(
          eq(rt2AgentMarketplace.id, listingId),
          eq(rt2AgentMarketplace.listingApprovalStatus, "approved"),
        ),
      )
      .limit(1);

    if (!listing) return null;

    const evidence = await getListingEvidence(listing);

    return {
      id: listing.id,
      creatorCompanyId: listing.creatorCompanyId,
      name: listing.name,
      description: listing.description,
      category: listing.category,
      tags: listing.tags as string[] | null,
      pricingType: listing.pricingType,
      pricePerTaskCents: listing.pricePerTaskCents,
      monthlySubscriptionCents: listing.monthlySubscriptionCents,
      adapterType: listing.adapterType,
      isActive: listing.isActive,
      totalSubscriptions: listing.totalSubscriptions,
      ratingAverage: listing.ratingAverage,
      ratingCount: listing.ratingCount,
      publicEvidence: {
        evidenceTier: deriveEvidenceTier(evidence.approvedDeliverableCount),
        reputationTier: deriveReputationTier(evidence.subscriptionCount),
        qualityTier: deriveQualityTier(evidence.averageQualityScore),
        evidenceStatus: evidence.evidenceStatus,
        pricingSummary: {
          pricingType: evidence.pricing.pricingType,
          priceLabel: getPricingLabel(
            evidence.pricing.pricingType,
            evidence.pricing.pricePerTaskCents,
            evidence.pricing.monthlySubscriptionCents,
          ),
        },
        approvalStatus: "approved",
      },
    };
  }

  /**
   * List public marketplace agents (only approved, public evidence contract)
   */
  async function listPublicMarketplaceAgents(
    category?: string,
    limit: number = 20,
    offset: number = 0,
  ): Promise<PublicMarketplaceListing[]> {
    const conditions = [
      eq(rt2AgentMarketplace.isActive, true),
      eq(rt2AgentMarketplace.listingApprovalStatus, "approved"),
    ];
    if (category) {
      conditions.push(eq(rt2AgentMarketplace.category, category));
    }

    const listings = await db
      .select()
      .from(rt2AgentMarketplace)
      .where(and(...conditions))
      .orderBy(desc(rt2AgentMarketplace.ratingAverage))
      .limit(limit)
      .offset(offset);

    return Promise.all(listings.map(async (listing) => {
      const evidence = await getListingEvidence(listing);
      return {
        id: listing.id,
        creatorCompanyId: listing.creatorCompanyId,
        name: listing.name,
        description: listing.description,
        category: listing.category,
        tags: listing.tags as string[] | null,
        pricingType: listing.pricingType,
        pricePerTaskCents: listing.pricePerTaskCents,
        monthlySubscriptionCents: listing.monthlySubscriptionCents,
        adapterType: listing.adapterType,
        isActive: listing.isActive,
        totalSubscriptions: listing.totalSubscriptions,
        ratingAverage: listing.ratingAverage,
        ratingCount: listing.ratingCount,
        publicEvidence: {
          evidenceTier: deriveEvidenceTier(evidence.approvedDeliverableCount),
          reputationTier: deriveReputationTier(evidence.subscriptionCount),
          qualityTier: deriveQualityTier(evidence.averageQualityScore),
          evidenceStatus: evidence.evidenceStatus,
          pricingSummary: {
            pricingType: evidence.pricing.pricingType,
            priceLabel: getPricingLabel(
              evidence.pricing.pricingType,
              evidence.pricing.pricePerTaskCents,
              evidence.pricing.monthlySubscriptionCents,
            ),
          },
          approvalStatus: "approved" as const,
        },
      };
    }));
  }

  return {
    // Marketplace
    listMarketplaceAgents,
    listCompanyMarketplaceAgents,
    searchMarketplaceAgents,
    searchCompanyMarketplaceAgents,
    getMarketplaceListing,
    createListing,
    // BYOA
    registerByoaAgent,
    getCompanyByoaAgents,
    updateByoaConnectionStatus,
    // Subscriptions
    subscribeToAgent,
    getCompanySubscriptions,
    cancelSubscription,
    recordTaskUsage,
    getActiveSubscription,
    // Public Marketplace (Phase 72)
    submitForApproval,
    approveListing,
    rejectListing,
    getPendingApprovals,
    getPublicMarketplaceListing,
    listPublicMarketplaceAgents,
  };
}
