CREATE TABLE "pending_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"waiting_agent_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_responses" ADD CONSTRAINT "pending_responses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pending_responses" ADD CONSTRAINT "pending_responses_waiting_agent_id_agents_id_fk" FOREIGN KEY ("waiting_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "pending_responses_company_status_idx" ON "pending_responses" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX "pending_responses_expires_idx" ON "pending_responses" USING btree ("expires_at");
