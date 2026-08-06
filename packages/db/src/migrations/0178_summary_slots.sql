CREATE TABLE IF NOT EXISTS "summary_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" uuid,
	"slot_key" text NOT NULL,
	"document_id" uuid,
	"status" text DEFAULT 'idle' NOT NULL,
	"generating_issue_id" uuid,
	"last_generated_at" timestamp with time zone,
	"last_generated_by_agent_id" uuid,
	"last_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "summary_slots_company_scope_slot_uq" UNIQUE NULLS NOT DISTINCT("company_id","scope_kind","scope_id","slot_key")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "summary_slots" ADD CONSTRAINT "summary_slots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "summary_slots" ADD CONSTRAINT "summary_slots_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "summary_slots" ADD CONSTRAINT "summary_slots_generating_issue_id_issues_id_fk" FOREIGN KEY ("generating_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "summary_slots" ADD CONSTRAINT "summary_slots_last_generated_by_agent_id_agents_id_fk" FOREIGN KEY ("last_generated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "summary_slots_document_uq" ON "summary_slots" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "summary_slots_company_scope_idx" ON "summary_slots" USING btree ("company_id","scope_kind","scope_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "summary_slots_company_generating_issue_idx" ON "summary_slots" USING btree ("company_id","generating_issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "summary_slots_company_updated_idx" ON "summary_slots" USING btree ("company_id","updated_at");
