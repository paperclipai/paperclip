import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Federation Partners - cross-company partnership relationships
 * FED-01: Cross-company federation has evidence sharing contracts
 * FED-02: Partner company evidence is isolated with per-company audit trails
 */
export const rt2FederationPartners = pgTable(
  "rt2_federation_partners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Local company initiating the partnership
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Partner company
    partnerCompanyId: uuid("partner_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Partnership status
    status: text("status").notNull().default("pending"), // pending | active | suspended | terminated
    // Partnership type
    partnershipType: text("partnership_type").notNull().default("bidirectional"), // unidirectional | bidirectional | marketplace
    // Evidence sharing level
    evidenceSharingLevel: text("evidence_sharing_level").notNull().default("none"), // none | public_only | quality_scores | full_settlements
    // Trust level for the partnership
    trustLevel: text("trust_level").notNull().default("unknown"), // unknown | verified | trusted | premium
    // Policy alignment
    policyAlignment: jsonb("policy_alignment").$type<{
      sharedAuditLogging: boolean;
      crossCompanyApprovals: boolean;
      evidenceContractSigned: boolean;
    }>().notNull().default({
      sharedAuditLogging: false,
      crossCompanyApprovals: false,
      evidenceContractSigned: false,
    }),
    // Allowed evidence types for sharing
    allowedEvidenceTypes: jsonb("allowed_evidence_types").$type<string[]>().notNull().default([]),
    // Expiry / renewal
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastRenewedAt: timestamp("last_renewed_at", { withTimezone: true }),
    // Partnership metadata
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPartnerIdx: index("federation_partners_company_partner_idx").on(table.companyId, table.partnerCompanyId),
    companyStatusIdx: index("federation_partners_company_status_idx").on(table.companyId, table.status),
    partnerCompanyIdx: index("federation_partners_partner_company_idx").on(table.partnerCompanyId),
  }),
);

/**
 * Federation Evidence Contracts - formal agreements for evidence sharing
 * FED-01: Evidence sharing contract across company boundary
 */
export const rt2FederationEvidenceContracts = pgTable(
  "rt2_federation_evidence_contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Federation partner this contract belongs to
    federationPartnerId: uuid("federation_partner_id").notNull().references(() => rt2FederationPartners.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Contract type
    contractType: text("contract_type").notNull(), // quality_evidence | settlement_summary | performance_review | full_transparency
    // Whether this contract is active
    isActive: boolean("is_active").notNull().default(true),
    // Evidence types included in this contract
    evidenceTypes: jsonb("evidence_types").$type<string[]>().notNull().default([]),
    // Data transformation rules (what to redact/aggregate)
    transformationRules: jsonb("transformation_rules").$type<{
      redactAmounts: boolean;
      redactNames: boolean;
      aggregateQuality: boolean;
      showTiersOnly: boolean;
    }>().notNull().default({
      redactAmounts: false,
      redactNames: false,
      aggregateQuality: false,
      showTiersOnly: false,
    }),
    // Audit requirements
    auditRequirements: jsonb("audit_requirements").$type<{
      logAllAccess: boolean;
      requireApprovalForAccess: boolean;
      retainAuditDays: number;
    }>().notNull().default({
      logAllAccess: true,
      requireApprovalForAccess: false,
      retainAuditDays: 365,
    }),
    // Contract hash for integrity verification
    contractHash: text("contract_hash"),
    // Timestamps
    signedAt: timestamp("signed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    partnerIdx: index("federation_contracts_partner_idx").on(table.federationPartnerId),
    companyIdx: index("federation_contracts_company_idx").on(table.companyId),
  }),
);

/**
 * Federation Audit Trails - isolated per-company audit for cross-company evidence access
 * FED-02: Per-company audit trail for evidence access across company boundary
 */
export const rt2FederationAuditTrails = pgTable(
  "rt2_federation_audit_trails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Local company that owns this audit trail
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Federation partner company involved
    federationPartnerId: uuid("federation_partner_id").notNull().references(() => rt2FederationPartners.id),
    // Evidence type accessed
    evidenceType: text("evidence_type").notNull(), // quality_score | settlement | reputation | career_profile | deliverable
    // Evidence record ID
    evidenceId: uuid("evidence_id"),
    // Action taken
    accessAction: text("access_action").notNull(), // viewed | shared | exported | approved | rejected
    // Result
    accessResult: text("access_result").notNull(), // success | denied | redacted | aggregated
    // Actor accessing (from partner company)
    accessedByActorId: text("accessed_by_actor_id"),
    accessedByActorType: text("accessed_by_actor_type"), // user | agent | system
    // Contract used for this access
    contractId: uuid("contract_id").references(() => rt2FederationEvidenceContracts.id),
    // Data that was actually shared (after transformation)
    sharedDataSummary: jsonb("shared_data_summary").$type<Record<string, unknown>>().notNull().default({}),
    // Redaction notes
    redactionNotes: text("redaction_notes"),
    // IP / network info
    accessNetworkInfo: jsonb("access_network_info").$type<{
      ipAddress: string;
      userAgent: string;
    }>().notNull().default({ ipAddress: "", userAgent: "" }),
    // Timestamps
    accessedAt: timestamp("accessed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAccessedAtIdx: index("federation_audit_company_accessed_idx").on(table.companyId, table.accessedAt),
    partnerIdx: index("federation_audit_partner_idx").on(table.federationPartnerId),
    evidenceIdx: index("federation_audit_evidence_idx").on(table.evidenceType, table.evidenceId),
  }),
);
