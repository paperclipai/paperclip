import { pgTable, uuid, text, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Agent marketplace listings - available agents in the marketplace
 */
export const rt2AgentMarketplace = pgTable(
  "rt2_agent_marketplace",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Creator company
    creatorCompanyId: uuid("creator_company_id").notNull().references(() => companies.id),
    // Agent name and description
    name: text("name").notNull(),
    description: text("description"),
    // Category and tags
    category: text("category").notNull(), // 'coding', 'design', 'writing', 'research', 'general'
    tags: text("tags").array(), // ['react', 'typescript', 'fastapi']
    // Pricing model
    pricingType: text("pricing_type").notNull().default("per_task"), // 'per_task', 'subscription', 'one_time'
    pricePerTaskCents: integer("price_per_task_cents"),
    monthlySubscriptionCents: integer("monthly_subscription_cents"),
    // Agent capabilities as JSON
    capabilities: text("capabilities").notNull().default("{}"), // JSON
    // Adapter type for this agent
    adapterType: text("adapter_type").notNull().default("process"),
    // Is this listing active?
    isActive: boolean("is_active").notNull().default(true),
    // Stats
    totalSubscriptions: integer("total_subscriptions").notNull().default(0),
    ratingAverage: integer("rating_average").notNull().default(0), // 0-5000 (0.0-5.0)
    ratingCount: integer("rating_count").notNull().default(0),
    // Approval workflow for public marketplace
    listingApprovalStatus: text("listing_approval_status").notNull().default("draft"), // 'draft' | 'pending_approval' | 'approved' | 'rejected'
    rejectionReason: text("rejection_reason"), // Reason when rejected
    submittedAt: timestamp("submitted_at", { withTimezone: true }), // When submitted for approval
    approvedAt: timestamp("approved_at", { withTimezone: true }), // When approved
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    creatorIdx: index("agent_marketplace_creator_idx").on(table.creatorCompanyId),
    categoryIdx: index("agent_marketplace_category_idx").on(table.category),
    activeIdx: index("agent_marketplace_active_idx").on(table.isActive),
    approvalStatusIdx: index("agent_marketplace_approval_status_idx").on(table.listingApprovalStatus),
  }),
);

/**
 * BYOA registrations - external agents registered by companies
 */
export const rt2ByoaAgents = pgTable(
  "rt2_byoa_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // External agent info
    name: text("name").notNull(),
    adapterType: text("adapter_type").notNull().default("process"),
    // Connection config (encrypted)
    connectionConfig: text("connection_config").notNull().default("{}"), // JSON - encrypted
    // Capabilities description
    capabilitiesDescription: text("capabilities_description"),
    // Status
    isConnected: boolean("is_connected").notNull().default(false),
    lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
    // Budget for this BYOA agent
    monthlyBudgetCents: integer("monthly_budget_cents").notNull().default(0),
    spentCents: integer("spent_cents").notNull().default(0),
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("byoa_agents_company_idx").on(table.companyId),
    connectedIdx: index("byoa_agents_connected_idx").on(table.isConnected),
  }),
);

/**
 * Agent subscriptions - companies subscribing to marketplace agents
 */
export const rt2AgentSubscriptions = pgTable(
  "rt2_agent_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    marketplaceListingId: uuid("marketplace_listing_id").notNull().references(() => rt2AgentMarketplace.id),
    // Subscription type
    subscriptionType: text("subscription_type").notNull(), // 'monthly', 'per_task', 'one_time'
    // Status
    status: text("status").notNull().default("active"), // 'active', 'cancelled', 'expired', 'trial'
    // Billing
    monthlyRateCents: integer("monthly_rate_cents"),
    tasksIncluded: integer("tasks_included"),
    tasksUsed: integer("tasks_used").notNull().default(0),
    // Trial
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    // Current period
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (table) => ({
    companyIdx: index("agent_subscriptions_company_idx").on(table.companyId),
    listingIdx: index("agent_subscriptions_listing_idx").on(table.marketplaceListingId),
    statusIdx: index("agent_subscriptions_status_idx").on(table.status),
  }),
);
