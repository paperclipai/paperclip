CREATE TABLE "agent_ownership_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"role" text NOT NULL,
	"granted_by_user_id" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" text,
	"revoked_reason" text,
	"transition_from_grant_id" uuid,
	"is_instance_admin_override" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_ownership_grants_principal_type_check" CHECK ("agent_ownership_grants"."principal_type" in ('user', 'agent')),
	CONSTRAINT "agent_ownership_grants_role_check" CHECK ("agent_ownership_grants"."role" in ('owner', 'admin', 'user')),
	CONSTRAINT "agent_ownership_grants_source_check" CHECK ("agent_ownership_grants"."source" in (
        'agent_create',
        'agent_created_default',
        'agent_hire',
        'manual_grant',
        'transfer_accept',
        'instance_admin_override',
        'instance_admin_bootstrap'
      ))
);
--> statement-breakpoint
CREATE TABLE "agent_ownership_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"from_user_id" text NOT NULL,
	"to_user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"proposed_by_user_id" text NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_by_user_id" text,
	"responded_at" timestamp with time zone,
	"forced_by_instance_admin_user_id" text,
	"resulting_grant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_ownership_transfers_status_check" CHECK ("agent_ownership_transfers"."status" in ('pending', 'accepted', 'declined', 'cancelled', 'forced'))
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "is_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "enforce_agent_ownership" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_ownership_grants" ADD CONSTRAINT "agent_ownership_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_ownership_grants" ADD CONSTRAINT "agent_ownership_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_ownership_grants" ADD CONSTRAINT "aog_transition_from_grant_id_fk" FOREIGN KEY ("transition_from_grant_id") REFERENCES "public"."agent_ownership_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_ownership_transfers" ADD CONSTRAINT "agent_ownership_transfers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_ownership_transfers" ADD CONSTRAINT "agent_ownership_transfers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_ownership_transfers" ADD CONSTRAINT "aot_resulting_grant_id_fk" FOREIGN KEY ("resulting_grant_id") REFERENCES "public"."agent_ownership_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_ownership_grants_one_active_owner_idx" ON "agent_ownership_grants" USING btree ("agent_id") WHERE "agent_ownership_grants"."role" = 'owner' and "agent_ownership_grants"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_ownership_grants_active_role_idx" ON "agent_ownership_grants" USING btree ("agent_id","principal_type","principal_id","role") WHERE "agent_ownership_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "agent_ownership_grants_agent_idx" ON "agent_ownership_grants" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_ownership_grants_company_idx" ON "agent_ownership_grants" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "agent_ownership_grants_principal_idx" ON "agent_ownership_grants" USING btree ("company_id","principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "agent_ownership_grants_transition_from_grant_id_idx" ON "agent_ownership_grants" USING btree ("transition_from_grant_id");--> statement-breakpoint
CREATE INDEX "agent_ownership_transfers_agent_idx" ON "agent_ownership_transfers" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_ownership_transfers_company_idx" ON "agent_ownership_transfers" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "agent_ownership_transfers_to_user_idx" ON "agent_ownership_transfers" USING btree ("to_user_id","status");--> statement-breakpoint
CREATE INDEX "agent_ownership_transfers_agent_status_idx" ON "agent_ownership_transfers" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "agent_ownership_transfers_resulting_grant_id_idx" ON "agent_ownership_transfers" USING btree ("resulting_grant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_ownership_transfers_one_pending_idx" ON "agent_ownership_transfers" USING btree ("agent_id") WHERE "agent_ownership_transfers"."status" = 'pending';