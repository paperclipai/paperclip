CREATE TABLE IF NOT EXISTS "rt2_sso_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "provider" text NOT NULL,
  "provider_config" jsonb,
  "is_active" boolean DEFAULT true NOT NULL,
  "client_id" text,
  "client_secret" text,
  "issuer_url" text,
  "metadata_url" text,
  "certificate" text,
  "user_mapping" jsonb,
  "auto_provision" boolean DEFAULT false NOT NULL,
  "default_role" text,
  "last_sync_at" timestamp with time zone,
  "sync_status" text DEFAULT 'idle' NOT NULL,
  "sync_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sso_connections_company_idx" ON "rt2_sso_connections" ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sso_connections_provider_idx" ON "rt2_sso_connections" ("provider");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sso_connections_active_idx" ON "rt2_sso_connections" ("is_active");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rt2_company_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "category" text NOT NULL,
  "version" text DEFAULT '1.0.0' NOT NULL,
  "is_public" boolean DEFAULT false NOT NULL,
  "author_company_id" uuid REFERENCES "companies"("id"),
  "template_data" jsonb NOT NULL,
  "usage_count" integer DEFAULT 0 NOT NULL,
  "rating_average" integer DEFAULT 0 NOT NULL,
  "rating_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_templates_category_idx" ON "rt2_company_templates" ("category");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_templates_public_idx" ON "rt2_company_templates" ("is_public");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_templates_author_idx" ON "rt2_company_templates" ("author_company_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rt2_tenant_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "policy_type" text NOT NULL,
  "isolation_level" text DEFAULT 'strict' NOT NULL,
  "data_tenant_policy" jsonb DEFAULT '{"separateDatabases":false,"separateSchemas":true,"rowLevelSecurity":true}'::jsonb NOT NULL,
  "resource_sharing" jsonb DEFAULT '{"sharedAgents":false,"sharedSkills":true,"sharedTemplates":true,"crossTenantCommunication":false}'::jsonb NOT NULL,
  "network_policy" jsonb DEFAULT '{"allowedIpRanges":[],"requireVpn":false,"enforceSsl":true}'::jsonb NOT NULL,
  "compliance_config" jsonb DEFAULT '{"dataResidency":"us-east-1","retentionDays":365,"auditLogging":true,"encryptionAtRest":true}'::jsonb NOT NULL,
  "quotas" jsonb DEFAULT '{"maxUsers":100,"maxAgents":50,"maxStorageBytes":10737418240,"maxApiCallsPerMonth":1000000}'::jsonb NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_policies_company_idx" ON "rt2_tenant_policies" ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_policies_type_idx" ON "rt2_tenant_policies" ("policy_type");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rt2_binding_modes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "mode" text NOT NULL,
  "network_config" jsonb NOT NULL,
  "security_config" jsonb DEFAULT '{"requireAuth":true,"sessionExpiryHours":24,"maxSessionAge":7,"allowAnonymousRead":false}'::jsonb NOT NULL,
  "environment" text DEFAULT 'production' NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "last_config_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "binding_modes_company_idx" ON "rt2_binding_modes" ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "binding_modes_mode_idx" ON "rt2_binding_modes" ("mode");
