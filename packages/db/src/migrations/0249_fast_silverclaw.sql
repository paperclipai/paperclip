-- Idempotent for workspaces that applied the pre-rebase review migrations.
CREATE TABLE IF NOT EXISTS "tool_action_deliveries" (
	"action_request_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"interaction_id" uuid NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_deliveries_action_request_id_tool_action_requests_id_fk' AND conrelid = 'public.tool_action_deliveries'::regclass) THEN
    ALTER TABLE "tool_action_deliveries" ADD CONSTRAINT "tool_action_deliveries_action_request_id_tool_action_requests_id_fk" FOREIGN KEY ("action_request_id") REFERENCES "public"."tool_action_requests"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_deliveries_company_id_companies_id_fk' AND conrelid = 'public.tool_action_deliveries'::regclass) THEN
    ALTER TABLE "tool_action_deliveries" ADD CONSTRAINT "tool_action_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_deliveries_issue_id_issues_id_fk' AND conrelid = 'public.tool_action_deliveries'::regclass) THEN
    ALTER TABLE "tool_action_deliveries" ADD CONSTRAINT "tool_action_deliveries_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_deliveries_interaction_id_issue_thread_interactions_id_fk' AND conrelid = 'public.tool_action_deliveries'::regclass) THEN
    ALTER TABLE "tool_action_deliveries" ADD CONSTRAINT "tool_action_deliveries_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_action_deliveries_pending_idx" ON "tool_action_deliveries" USING btree ("delivered_at","created_at");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Transactional migrations require the unique delivery claim before writers start. This new key namespace has no rows, but index construction can briefly block wakeup writes.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_tool_action_delivery_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'tool-action-response:%' AND "agent_wakeup_requests"."status" NOT IN ('skipped', 'failed', 'cancelled');