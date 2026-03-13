CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope_type" text DEFAULT 'company' NOT NULL,
	"scope_id" uuid,
	"category" text DEFAULT 'knowledge' NOT NULL,
	"content" text NOT NULL,
	"confidence" double precision DEFAULT 0.9 NOT NULL,
	"source_agent_id" uuid,
	"source_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_agent_id_agents_id_fk" FOREIGN KEY ("source_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_company_idx" ON "memories" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "memories_company_scope_idx" ON "memories" USING btree ("company_id","scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "memories_company_category_idx" ON "memories" USING btree ("company_id","category");