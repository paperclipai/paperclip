-- Dot-only additions after the merged public MCP gateway. Safe to reapply to a prototype schema.
CREATE TABLE IF NOT EXISTS "dot_agent_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"operator_id" text NOT NULL,
	"grant_id" uuid,
	"generation" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pairing' NOT NULL,
	"pairing_code_hash" text,
	"pairing_expires_at" timestamp with time zone,
	"dot_url" text,
	"challenge_hash" text,
	"challenge_expires_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dot_mailbox_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"binding_generation" integer NOT NULL,
	"assignment_id" uuid,
	"kind" text NOT NULL,
	"source_event_id" text NOT NULL,
	"references" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dot_runner_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"binding_generation" integer NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"normalized_session_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"controller_generation" integer NOT NULL,
	"catalog_digest" text NOT NULL,
	"status" text NOT NULL,
	"projection" jsonb NOT NULL,
	"accept_by" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dot_runner_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"command" jsonb NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"outcome" jsonb,
	"source_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_event_deliveries" ALTER COLUMN "activity_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "mcp_event_subscriptions" ALTER COLUMN "task_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "mcp_event_deliveries" ADD COLUMN IF NOT EXISTS "mailbox_item_id" integer;
--> statement-breakpoint
ALTER TABLE "mcp_event_subscriptions" ADD COLUMN IF NOT EXISTS "binding_id" uuid;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD COLUMN IF NOT EXISTS "purpose" text DEFAULT 'personal' NOT NULL;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD COLUMN IF NOT EXISTS "agent_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dot_agent_bindings_company_id_companies_id_fk' AND conrelid = 'public.dot_agent_bindings'::regclass) THEN
    ALTER TABLE "dot_agent_bindings" ADD CONSTRAINT "dot_agent_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dot_agent_bindings_agent_id_agents_id_fk' AND conrelid = 'public.dot_agent_bindings'::regclass) THEN
    ALTER TABLE "dot_agent_bindings" ADD CONSTRAINT "dot_agent_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dot_agent_bindings_grant_id_mcp_oauth_grants_id_fk' AND conrelid = 'public.dot_agent_bindings'::regclass) THEN
    ALTER TABLE "dot_agent_bindings" ADD CONSTRAINT "dot_agent_bindings_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dot_mailbox_items_company_id_companies_id_fk' AND conrelid = 'public.dot_mailbox_items'::regclass) THEN
    ALTER TABLE "dot_mailbox_items" ADD CONSTRAINT "dot_mailbox_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dot_mailbox_items_binding_id_dot_agent_bindings_id_fk' AND conrelid = 'public.dot_mailbox_items'::regclass) THEN
    ALTER TABLE "dot_mailbox_items" ADD CONSTRAINT "dot_mailbox_items_binding_id_dot_agent_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."dot_agent_bindings"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dot_mailbox_items_assignment_id_dot_runner_assignments_id_fk' AND conrelid = 'public.dot_mailbox_items'::regclass) THEN
    ALTER TABLE "dot_mailbox_items" ADD CONSTRAINT "dot_mailbox_items_assignment_id_dot_runner_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."dot_runner_assignments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dot_runner_assignments_company_id_companies_id_fk' AND conrelid = 'public.dot_runner_assignments'::regclass) THEN
    ALTER TABLE "dot_runner_assignments" ADD CONSTRAINT "dot_runner_assignments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dot_runner_assignments_binding_id_dot_agent_bindings_id_fk' AND conrelid = 'public.dot_runner_assignments'::regclass) THEN
    ALTER TABLE "dot_runner_assignments" ADD CONSTRAINT "dot_runner_assignments_binding_id_dot_agent_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."dot_agent_bindings"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dot_runner_assignments_run_id_heartbeat_runs_id_fk' AND conrelid = 'public.dot_runner_assignments'::regclass) THEN
    ALTER TABLE "dot_runner_assignments" ADD CONSTRAINT "dot_runner_assignments_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dot_runner_assignments_agent_id_agents_id_fk' AND conrelid = 'public.dot_runner_assignments'::regclass) THEN
    ALTER TABLE "dot_runner_assignments" ADD CONSTRAINT "dot_runner_assignments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dot_runner_operations_company_id_companies_id_fk' AND conrelid = 'public.dot_runner_operations'::regclass) THEN
    ALTER TABLE "dot_runner_operations" ADD CONSTRAINT "dot_runner_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dot_runner_operations_assignment_id_dot_runner_assignments_id_fk' AND conrelid = 'public.dot_runner_operations'::regclass) THEN
    ALTER TABLE "dot_runner_operations" ADD CONSTRAINT "dot_runner_operations_assignment_id_dot_runner_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."dot_runner_assignments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dot_bindings_active_agent_uq" ON "dot_agent_bindings" USING btree ("company_id","agent_id") WHERE "dot_agent_bindings"."revoked_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dot_bindings_active_grant_uq" ON "dot_agent_bindings" USING btree ("grant_id") WHERE "dot_agent_bindings"."revoked_at" IS NULL AND "dot_agent_bindings"."grant_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dot_bindings_pairing_code_uq" ON "dot_agent_bindings" USING btree ("pairing_code_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dot_mailbox_event_uq" ON "dot_mailbox_items" USING btree ("binding_id","binding_generation","source_event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dot_mailbox_binding_cursor_idx" ON "dot_mailbox_items" USING btree ("binding_id","binding_generation","id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dot_assignments_turn_uq" ON "dot_runner_assignments" USING btree ("run_id","turn_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dot_assignments_active_binding_uq" ON "dot_runner_assignments" USING btree ("binding_id") WHERE "dot_runner_assignments"."status" IN ('offered', 'accepted');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dot_assignments_company_idx" ON "dot_runner_assignments" USING btree ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dot_operations_request_uq" ON "dot_runner_operations" USING btree ("assignment_id","request_id");
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_oauth_grants_agent_id_agents_id_fk' AND conrelid = 'public.mcp_oauth_grants'::regclass) THEN
    ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_event_deliveries_mailbox_uq" ON "mcp_event_deliveries" USING btree ("subscription_id","mailbox_item_id");
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_delivery_source_check' AND conrelid = 'public.mcp_event_deliveries'::regclass) THEN
    ALTER TABLE "mcp_event_deliveries" ADD CONSTRAINT "mcp_delivery_source_check" CHECK (("mcp_event_deliveries"."activity_id" IS NOT NULL AND "mcp_event_deliveries"."mailbox_item_id" IS NULL) OR ("mcp_event_deliveries"."activity_id" IS NULL AND "mcp_event_deliveries"."mailbox_item_id" IS NOT NULL));
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_subscription_resource_check' AND conrelid = 'public.mcp_event_subscriptions'::regclass) THEN
    ALTER TABLE "mcp_event_subscriptions" ADD CONSTRAINT "mcp_subscription_resource_check" CHECK (("mcp_event_subscriptions"."task_id" IS NOT NULL AND "mcp_event_subscriptions"."binding_id" IS NULL) OR ("mcp_event_subscriptions"."task_id" IS NULL AND "mcp_event_subscriptions"."binding_id" IS NOT NULL));
  END IF;
END $$;
