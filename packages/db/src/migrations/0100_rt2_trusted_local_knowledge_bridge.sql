CREATE TABLE "rt2_v33_knowledge_bridge_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bridge_name" text NOT NULL,
	"vault_name" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'paired' NOT NULL,
	"blocked_reason" text,
	"conflict_count" text DEFAULT '0' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_applied_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rt2_v33_knowledge_bridge_pairings" ADD CONSTRAINT "rt2_v33_knowledge_bridge_pairings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "rt2_v33_knowledge_bridge_pairings_company_uq" ON "rt2_v33_knowledge_bridge_pairings" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "rt2_v33_knowledge_bridge_pairings_company_status_idx" ON "rt2_v33_knowledge_bridge_pairings" USING btree ("company_id","status");
--> statement-breakpoint
CREATE TABLE "rt2_v33_knowledge_bridge_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bridge_id" uuid,
	"operation" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"page_key" text,
	"vault_path" text,
	"candidate_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blocked_reason" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "rt2_v33_knowledge_bridge_queue" ADD CONSTRAINT "rt2_v33_knowledge_bridge_queue_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_knowledge_bridge_queue" ADD CONSTRAINT "rt2_v33_knowledge_bridge_queue_bridge_id_rt2_v33_knowledge_bridge_pairings_id_fk" FOREIGN KEY ("bridge_id") REFERENCES "public"."rt2_v33_knowledge_bridge_pairings"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "rt2_v33_knowledge_bridge_queue_company_status_idx" ON "rt2_v33_knowledge_bridge_queue" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX "rt2_v33_knowledge_bridge_queue_company_created_idx" ON "rt2_v33_knowledge_bridge_queue" USING btree ("company_id","created_at");
