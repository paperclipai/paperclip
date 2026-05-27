CREATE TABLE IF NOT EXISTS "proposal_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" text NOT NULL,
	"filename" text,
	"mime_type" text,
	"extracted_text" text NOT NULL,
	"extraction_notes" text,
	"created_by_user_id" text,
	"created_company_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "opc_blueprints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"summary" text NOT NULL,
	"target_customer" text NOT NULL,
	"mvp_wedge" text NOT NULL,
	"ux_notes" text NOT NULL,
	"architecture_notes" text NOT NULL,
	"risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assumptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deliverables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"budget_time_guesses" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"launch_plan" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_plan" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"issue_plan" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"routine_plan" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by_user_id" text,
	"created_company_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "coach_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"blueprint_id" uuid,
	"question" text NOT NULL,
	"selected_answer" text NOT NULL,
	"rationale" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proposal_artifacts_created_company_id_companies_id_fk') THEN
		ALTER TABLE "proposal_artifacts" ADD CONSTRAINT "proposal_artifacts_created_company_id_companies_id_fk" FOREIGN KEY ("created_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opc_blueprints_proposal_id_proposal_artifacts_id_fk') THEN
		ALTER TABLE "opc_blueprints" ADD CONSTRAINT "opc_blueprints_proposal_id_proposal_artifacts_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal_artifacts"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opc_blueprints_created_company_id_companies_id_fk') THEN
		ALTER TABLE "opc_blueprints" ADD CONSTRAINT "opc_blueprints_created_company_id_companies_id_fk" FOREIGN KEY ("created_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coach_decisions_proposal_id_proposal_artifacts_id_fk') THEN
		ALTER TABLE "coach_decisions" ADD CONSTRAINT "coach_decisions_proposal_id_proposal_artifacts_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal_artifacts"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coach_decisions_blueprint_id_opc_blueprints_id_fk') THEN
		ALTER TABLE "coach_decisions" ADD CONSTRAINT "coach_decisions_blueprint_id_opc_blueprints_id_fk" FOREIGN KEY ("blueprint_id") REFERENCES "public"."opc_blueprints"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proposal_artifacts_created_at_idx" ON "proposal_artifacts" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opc_blueprints_proposal_idx" ON "opc_blueprints" USING btree ("proposal_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opc_blueprints_created_company_idx" ON "opc_blueprints" USING btree ("created_company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coach_decisions_proposal_created_idx" ON "coach_decisions" USING btree ("proposal_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "coach_decisions_proposal_question_uq" ON "coach_decisions" USING btree ("proposal_id","question");
