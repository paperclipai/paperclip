CREATE TABLE IF NOT EXISTS "legal_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"external_ref" text,
	"primary_contact" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"conflicts_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "legal_matters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"client_id" uuid,
	"title" text NOT NULL,
	"matter_type" text NOT NULL,
	"practice_area" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"privilege_ring" text DEFAULT 'attorney-client' NOT NULL,
	"summary" text,
	"profile_key" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"opened_by_user_id" text,
	"closed_at" timestamp with time zone,
	"closed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "legal_conflict_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"matter_id" uuid,
	"client_id" uuid,
	"conflict_type" text NOT NULL,
	"conflicted_party_name" text NOT NULL,
	"conflict_description" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"detected_by_agent_id" uuid,
	"waived_by_user_id" text,
	"waived_at" timestamp with time zone,
	"waiver_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "legal_privilege_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"artifact_type" text NOT NULL,
	"artifact_id" uuid NOT NULL,
	"privilege_ring" text NOT NULL,
	"rationale" text,
	"propagated_from_flag_id" uuid,
	"tagged_by_agent_id" uuid,
	"tagged_by_user_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "legal_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"matter_id" uuid,
	"risk_gate_key" text NOT NULL,
	"requested_by_agent_id" uuid,
	"requested_by_user_id" text,
	"approver_role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"rationale" text,
	"decision_note" text,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "legal_risk_gate_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"matter_id" uuid,
	"approval_id" uuid,
	"risk_gate_key" text NOT NULL,
	"triggered_by_agent_id" uuid,
	"trigger_action" text NOT NULL,
	"trigger_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"gate_definition_version" text,
	"profile_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_clients_company_id_companies_id_fk') THEN
		ALTER TABLE "legal_clients" ADD CONSTRAINT "legal_clients_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_matters_company_id_companies_id_fk') THEN
		ALTER TABLE "legal_matters" ADD CONSTRAINT "legal_matters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_matters_client_id_legal_clients_id_fk') THEN
		ALTER TABLE "legal_matters" ADD CONSTRAINT "legal_matters_client_id_legal_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."legal_clients"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_conflict_records_company_id_companies_id_fk') THEN
		ALTER TABLE "legal_conflict_records" ADD CONSTRAINT "legal_conflict_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_conflict_records_matter_id_legal_matters_id_fk') THEN
		ALTER TABLE "legal_conflict_records" ADD CONSTRAINT "legal_conflict_records_matter_id_legal_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."legal_matters"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_conflict_records_client_id_legal_clients_id_fk') THEN
		ALTER TABLE "legal_conflict_records" ADD CONSTRAINT "legal_conflict_records_client_id_legal_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."legal_clients"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_privilege_flags_company_id_companies_id_fk') THEN
		ALTER TABLE "legal_privilege_flags" ADD CONSTRAINT "legal_privilege_flags_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_privilege_flags_matter_id_legal_matters_id_fk') THEN
		ALTER TABLE "legal_privilege_flags" ADD CONSTRAINT "legal_privilege_flags_matter_id_legal_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."legal_matters"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_approvals_company_id_companies_id_fk') THEN
		ALTER TABLE "legal_approvals" ADD CONSTRAINT "legal_approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_approvals_matter_id_legal_matters_id_fk') THEN
		ALTER TABLE "legal_approvals" ADD CONSTRAINT "legal_approvals_matter_id_legal_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."legal_matters"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_risk_gate_events_company_id_companies_id_fk') THEN
		ALTER TABLE "legal_risk_gate_events" ADD CONSTRAINT "legal_risk_gate_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_risk_gate_events_matter_id_legal_matters_id_fk') THEN
		ALTER TABLE "legal_risk_gate_events" ADD CONSTRAINT "legal_risk_gate_events_matter_id_legal_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."legal_matters"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_risk_gate_events_approval_id_legal_approvals_id_fk') THEN
		ALTER TABLE "legal_risk_gate_events" ADD CONSTRAINT "legal_risk_gate_events_approval_id_legal_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."legal_approvals"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_clients_company_status_idx" ON "legal_clients" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_clients_company_name_idx" ON "legal_clients" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_matters_company_status_practice_area_idx" ON "legal_matters" USING btree ("company_id","status","practice_area");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_matters_company_client_idx" ON "legal_matters" USING btree ("company_id","client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_conflict_records_company_status_idx" ON "legal_conflict_records" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_conflict_records_company_matter_idx" ON "legal_conflict_records" USING btree ("company_id","matter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_conflict_records_company_client_idx" ON "legal_conflict_records" USING btree ("company_id","client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_privilege_flags_company_matter_artifact_idx" ON "legal_privilege_flags" USING btree ("company_id","matter_id","artifact_type","artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "legal_privilege_flags_artifact_uq" ON "legal_privilege_flags" USING btree ("company_id","artifact_type","artifact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_approvals_company_status_gate_idx" ON "legal_approvals" USING btree ("company_id","status","risk_gate_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_approvals_company_matter_idx" ON "legal_approvals" USING btree ("company_id","matter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_risk_gate_events_company_gate_outcome_idx" ON "legal_risk_gate_events" USING btree ("company_id","risk_gate_key","outcome");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_risk_gate_events_company_matter_idx" ON "legal_risk_gate_events" USING btree ("company_id","matter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_risk_gate_events_company_approval_idx" ON "legal_risk_gate_events" USING btree ("company_id","approval_id");
