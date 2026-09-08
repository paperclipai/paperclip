CREATE TABLE "connection_intent_deliveries" (
	"interaction_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connection_intent_deliveries" ADD CONSTRAINT "connection_intent_deliveries_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_intent_deliveries" ADD CONSTRAINT "connection_intent_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_intent_deliveries_pending_idx" ON "connection_intent_deliveries" USING btree ("delivered_at","next_attempt_at");