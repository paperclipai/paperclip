import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * SSO Connections - Enterprise SSO integration
 * M3.5: SSO
 */
export const rt2SsoConnections = pgTable(
  "rt2_sso_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // SSO provider
    provider: text("provider").notNull(), // 'google', 'github', 'microsoft', 'okta', 'custom'
    providerConfig: jsonb("provider_config").$type<Record<string, unknown>>(),
    // Connection status
    isActive: boolean("is_active").notNull().default(true),
    // Auth config
    clientId: text("client_id"),
    clientSecret: text("client_secret"), // encrypted
    issuerUrl: text("issuer_url"),
    // SAML/OIDC config
    metadataUrl: text("metadata_url"),
    certificate: text("certificate"),
    // User mapping
    userMapping: jsonb("user_mapping").$type<{
      emailField: string;
      nameField: string;
      roleField?: string;
    }>(),
    // Auto-provisioning
    autoProvision: boolean("auto_provision").notNull().default(false),
    defaultRole: text("default_role"),
    // Status
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    syncStatus: text("sync_status").notNull().default("idle"), // 'idle', 'syncing', 'error'
    syncError: text("sync_error"),
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("sso_connections_company_idx").on(table.companyId),
    providerIdx: index("sso_connections_provider_idx").on(table.provider),
    activeIdx: index("sso_connections_active_idx").on(table.isActive),
  }),
);

/**
 * Company templates - portable company configurations
 * M3.5: Portable Company Templates
 */
export const rt2CompanyTemplates = pgTable(
  "rt2_company_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Template metadata
    name: text("name").notNull(),
    description: text("description"),
    category: text("category").notNull(), // 'startup', 'agency', 'enterprise', 'custom'
    // Version
    version: text("version").notNull().default("1.0.0"),
    isPublic: boolean("is_public").notNull().default(false),
    // Template author
    authorCompanyId: uuid("author_company_id").references(() => companies.id),
    // Included components
    templateData: jsonb("template_data").$type<{
      // Organizational structure
      departments: Array<{
        name: string;
        roles: string[];
        headRole: string;
      }>;
      // Standard workflows
      workflows: Array<{
        name: string;
        steps: string[];
        approvals: string[];
      }>;
      // Default skills
      skills: string[];
      // Budget templates
      budgetPolicy: {
        monthlyBudgetCents: number;
        alertsAtPercent: number[];
      };
      // Governance rules
      governance: {
        requireApprovalForHires: boolean;
        requireApprovalForBudget: boolean;
        maxAgentBudgetCents: number;
      };
      // Agent configurations
      agentConfigs: Array<{
        role: string;
        adapterType: string;
        capabilities: string[];
        monthlyBudgetCents: number;
      }>;
    }>().notNull(),
    // Stats
    usageCount: integer("usage_count").notNull().default(0),
    ratingAverage: integer("rating_average").notNull().default(0),
    ratingCount: integer("rating_count").notNull().default(0),
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    categoryIdx: index("company_templates_category_idx").on(table.category),
    publicIdx: index("company_templates_public_idx").on(table.isPublic),
    authorIdx: index("company_templates_author_idx").on(table.authorCompanyId),
  }),
);

/**
 * Tenant policies - multi-tenancy configuration
 * M3.5: 멀티테넨시
 */
export const rt2TenantPolicies = pgTable(
  "rt2_tenant_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // Policy type
    policyType: text("policy_type").notNull(), // 'isolation', 'sharing', 'federation'
    // Isolation level
    isolationLevel: text("isolation_level").notNull().default("strict"), // 'strict', 'shared', 'federated'
    // Data isolation
    dataIsolation: jsonb("data_tenant_policy").$type<{
      separateDatabases: boolean;
      separateSchemas: boolean;
      rowLevelSecurity: boolean;
    }>().notNull().default({
      separateDatabases: false,
      separateSchemas: true,
      rowLevelSecurity: true,
    }),
    // Resource sharing
    resourceSharing: jsonb("resource_sharing").$type<{
      sharedAgents: boolean;
      sharedSkills: boolean;
      sharedTemplates: boolean;
      crossTenantCommunication: boolean;
    }>().notNull().default({
      sharedAgents: false,
      sharedSkills: true,
      sharedTemplates: true,
      crossTenantCommunication: false,
    }),
    // Network policies
    networkPolicy: jsonb("network_policy").$type<{
      allowedIpRanges: string[];
      requireVpn: boolean;
      enforceSsl: boolean;
    }>().notNull().default({
      allowedIpRanges: [],
      requireVpn: false,
      enforceSsl: true,
    }),
    // Compliance
    complianceConfig: jsonb("compliance_config").$type<{
      dataResidency: string;
      retentionDays: number;
      auditLogging: boolean;
      encryptionAtRest: boolean;
    }>().notNull().default({
      dataResidency: "us-east-1",
      retentionDays: 365,
      auditLogging: true,
      encryptionAtRest: true,
    }),
    // Quotas
    quotas: jsonb("quotas").$type<{
      maxUsers: number;
      maxAgents: number;
      maxStorageBytes: number;
      maxApiCallsPerMonth: number;
    }>().notNull().default({
      maxUsers: 100,
      maxAgents: 50,
      maxStorageBytes: 10 * 1024 * 1024 * 1024, // 10GB
      maxApiCallsPerMonth: 1000000,
    }),
    // Status
    isActive: boolean("is_active").notNull().default(true),
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("tenant_policies_company_idx").on(table.companyId),
    policyTypeIdx: index("tenant_policies_type_idx").on(table.policyType),
  }),
);

/**
 * Binding modes - deployment configuration
 * M3.5: Binding Modes
 */
export const rt2BindingModes = pgTable(
  "rt2_binding_modes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // Binding mode
    mode: text("mode").notNull(), // 'local_trusted', 'authenticated', 'lan', 'tailnet', 'cloud'
    // Network config
    networkConfig: jsonb("network_config").$type<{
      allowedHosts: string[];
      bindHost: string;
      port: number;
      corsOrigins: string[];
    }>().notNull(),
    // Security config
    securityConfig: jsonb("security_config").$type<{
      requireAuth: boolean;
      sessionExpiryHours: number;
      maxSessionAge: number;
      allowAnonymousRead: boolean;
    }>().notNull().default({
      requireAuth: true,
      sessionExpiryHours: 24,
      maxSessionAge: 7,
      allowAnonymousRead: false,
    }),
    // Deployment environment
    environment: text("environment").notNull().default("production"), // 'development', 'staging', 'production'
    // Status
    isActive: boolean("is_active").notNull().default(true),
    lastConfigAt: timestamp("last_config_at", { withTimezone: true }),
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("binding_modes_company_idx").on(table.companyId),
    modeIdx: index("binding_modes_mode_idx").on(table.mode),
  }),
);

export const rt2EnterpriseConnectorEvidence = pgTable(
  "rt2_enterprise_connector_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    connectorKind: text("connector_kind").notNull(),
    evidenceType: text("evidence_type").notNull(),
    status: text("status").notNull(),
    provider: text("provider"),
    sourceLabel: text("source_label"),
    previewEvidenceId: uuid("preview_evidence_id"),
    fingerprint: text("fingerprint"),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull().default({}),
    checks: jsonb("checks").$type<unknown[]>().notNull().default([]),
    candidates: jsonb("candidates").$type<unknown[]>().notNull().default([]),
    rollbackCandidates: jsonb("rollback_candidates").$type<unknown[]>().notNull().default([]),
    failureReasons: jsonb("failure_reasons").$type<unknown[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
  },
  (table) => ({
    companyLatestIdx: index("rt2_enterprise_connector_evidence_company_latest_idx").on(
      table.companyId,
      table.connectorKind,
      table.evidenceType,
      table.createdAt,
    ),
    companyPreviewIdx: index("rt2_enterprise_connector_evidence_company_preview_idx").on(
      table.companyId,
      table.previewEvidenceId,
    ),
    fingerprintIdx: index("rt2_enterprise_connector_evidence_fingerprint_idx").on(table.fingerprint),
  }),
);
