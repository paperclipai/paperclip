CREATE TABLE IF NOT EXISTS "decision_queue_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"queue_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"added_by_type" text NOT NULL,
	"added_by_agent_id" uuid,
	"added_by_user_id" text,
	"added_by_run_id" uuid,
	"added_by_agent_api_key_id" uuid,
	"responsible_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_queue_items_actor_check" CHECK ((
        ("decision_queue_items"."added_by_type" = 'agent' AND "decision_queue_items"."added_by_agent_id" IS NOT NULL AND "decision_queue_items"."added_by_user_id" IS NULL)
        OR ("decision_queue_items"."added_by_type" = 'user' AND "decision_queue_items"."added_by_agent_id" IS NULL AND "decision_queue_items"."added_by_user_id" IS NOT NULL)
        OR ("decision_queue_items"."added_by_type" = 'system' AND "decision_queue_items"."added_by_agent_id" IS NULL AND "decision_queue_items"."added_by_user_id" IS NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decision_queues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"created_by_type" text NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"created_by_agent_api_key_id" uuid,
	"retention_days" integer,
	"seed_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seed_rules_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_queues_creator_check" CHECK ((
        ("decision_queues"."created_by_type" = 'agent' AND "decision_queues"."created_by_agent_id" IS NOT NULL AND "decision_queues"."created_by_user_id" IS NULL)
        OR ("decision_queues"."created_by_type" = 'user' AND "decision_queues"."created_by_agent_id" IS NULL AND "decision_queues"."created_by_user_id" IS NOT NULL)
        OR ("decision_queues"."created_by_type" = 'system' AND "decision_queues"."created_by_agent_id" IS NULL AND "decision_queues"."created_by_user_id" IS NULL)
      )),
	CONSTRAINT "decision_queues_retention_days_check" CHECK ("decision_queues"."retention_days" IS NULL OR ("decision_queues"."retention_days" >= 1 AND "decision_queues"."retention_days" <= 3650))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decision_triage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"decide_by" text,
	"decide_by_date" date,
	"snoozed_until" timestamp with time zone,
	"set_by_type" text NOT NULL,
	"set_by_agent_id" uuid,
	"set_by_user_id" text,
	"set_by_run_id" uuid,
	"set_by_agent_api_key_id" uuid,
	"responsible_user_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_triage_actor_check" CHECK ((
        ("decision_triage"."set_by_type" = 'agent' AND "decision_triage"."set_by_agent_id" IS NOT NULL AND "decision_triage"."set_by_user_id" IS NULL)
        OR ("decision_triage"."set_by_type" = 'user' AND "decision_triage"."set_by_agent_id" IS NULL AND "decision_triage"."set_by_user_id" IS NOT NULL)
      )),
	CONSTRAINT "decision_triage_decide_by_check" CHECK ((
        ("decision_triage"."decide_by" IS NULL AND "decision_triage"."decide_by_date" IS NULL)
        OR ("decision_triage"."decide_by" IN ('today', 'this_week', 'whenever') AND "decision_triage"."decide_by_date" IS NULL)
        OR ("decision_triage"."decide_by" = 'date' AND "decision_triage"."decide_by_date" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decision_triage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"queue_id" uuid,
	"source_kind" text,
	"source_id" text,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_agent_id" uuid,
	"actor_user_id" text,
	"actor_run_id" uuid,
	"agent_api_key_id" uuid,
	"responsible_user_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_triage_events_actor_check" CHECK ((
        ("decision_triage_events"."actor_type" = 'agent' AND "decision_triage_events"."actor_agent_id" IS NOT NULL AND "decision_triage_events"."actor_user_id" IS NULL)
        OR ("decision_triage_events"."actor_type" = 'user' AND "decision_triage_events"."actor_agent_id" IS NULL AND "decision_triage_events"."actor_user_id" IS NOT NULL)
        OR ("decision_triage_events"."actor_type" = 'system' AND "decision_triage_events"."actor_agent_id" IS NULL AND "decision_triage_events"."actor_user_id" IS NULL)
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "decision_queues_id_company_uq" ON "decision_queues" USING btree ("id","company_id");
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_queue_items_company_id_companies_id_fk' AND conrelid = 'public.decision_queue_items'::regclass) THEN
		ALTER TABLE "decision_queue_items" ADD CONSTRAINT "decision_queue_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_queue_items_added_by_agent_id_agents_id_fk' AND conrelid = 'public.decision_queue_items'::regclass) THEN
		ALTER TABLE "decision_queue_items" ADD CONSTRAINT "decision_queue_items_added_by_agent_id_agents_id_fk" FOREIGN KEY ("added_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_queue_items_added_by_run_id_heartbeat_runs_id_fk' AND conrelid = 'public.decision_queue_items'::regclass) THEN
		ALTER TABLE "decision_queue_items" ADD CONSTRAINT "decision_queue_items_added_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("added_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_queue_items_added_by_agent_api_key_id_agent_api_keys_id_fk' AND conrelid = 'public.decision_queue_items'::regclass) THEN
		ALTER TABLE "decision_queue_items" ADD CONSTRAINT "decision_queue_items_added_by_agent_api_key_id_agent_api_keys_id_fk" FOREIGN KEY ("added_by_agent_api_key_id") REFERENCES "public"."agent_api_keys"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_queue_items_queue_company_fk' AND conrelid = 'public.decision_queue_items'::regclass) THEN
		ALTER TABLE "decision_queue_items" ADD CONSTRAINT "decision_queue_items_queue_company_fk" FOREIGN KEY ("queue_id","company_id") REFERENCES "public"."decision_queues"("id","company_id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_queues_company_id_companies_id_fk' AND conrelid = 'public.decision_queues'::regclass) THEN
		ALTER TABLE "decision_queues" ADD CONSTRAINT "decision_queues_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_queues_created_by_agent_id_agents_id_fk' AND conrelid = 'public.decision_queues'::regclass) THEN
		ALTER TABLE "decision_queues" ADD CONSTRAINT "decision_queues_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_queues_created_by_run_id_heartbeat_runs_id_fk' AND conrelid = 'public.decision_queues'::regclass) THEN
		ALTER TABLE "decision_queues" ADD CONSTRAINT "decision_queues_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_queues_created_by_agent_api_key_id_agent_api_keys_id_fk' AND conrelid = 'public.decision_queues'::regclass) THEN
		ALTER TABLE "decision_queues" ADD CONSTRAINT "decision_queues_created_by_agent_api_key_id_agent_api_keys_id_fk" FOREIGN KEY ("created_by_agent_api_key_id") REFERENCES "public"."agent_api_keys"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_triage_company_id_companies_id_fk' AND conrelid = 'public.decision_triage'::regclass) THEN
		ALTER TABLE "decision_triage" ADD CONSTRAINT "decision_triage_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_triage_set_by_agent_id_agents_id_fk' AND conrelid = 'public.decision_triage'::regclass) THEN
		ALTER TABLE "decision_triage" ADD CONSTRAINT "decision_triage_set_by_agent_id_agents_id_fk" FOREIGN KEY ("set_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_triage_set_by_run_id_heartbeat_runs_id_fk' AND conrelid = 'public.decision_triage'::regclass) THEN
		ALTER TABLE "decision_triage" ADD CONSTRAINT "decision_triage_set_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("set_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_triage_set_by_agent_api_key_id_agent_api_keys_id_fk' AND conrelid = 'public.decision_triage'::regclass) THEN
		ALTER TABLE "decision_triage" ADD CONSTRAINT "decision_triage_set_by_agent_api_key_id_agent_api_keys_id_fk" FOREIGN KEY ("set_by_agent_api_key_id") REFERENCES "public"."agent_api_keys"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_triage_events_company_id_companies_id_fk' AND conrelid = 'public.decision_triage_events'::regclass) THEN
		ALTER TABLE "decision_triage_events" ADD CONSTRAINT "decision_triage_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_triage_events_queue_id_decision_queues_id_fk' AND conrelid = 'public.decision_triage_events'::regclass) THEN
		ALTER TABLE "decision_triage_events" ADD CONSTRAINT "decision_triage_events_queue_id_decision_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."decision_queues"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_triage_events_actor_agent_id_agents_id_fk' AND conrelid = 'public.decision_triage_events'::regclass) THEN
		ALTER TABLE "decision_triage_events" ADD CONSTRAINT "decision_triage_events_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_triage_events_actor_run_id_heartbeat_runs_id_fk' AND conrelid = 'public.decision_triage_events'::regclass) THEN
		ALTER TABLE "decision_triage_events" ADD CONSTRAINT "decision_triage_events_actor_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("actor_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_triage_events_agent_api_key_id_agent_api_keys_id_fk' AND conrelid = 'public.decision_triage_events'::regclass) THEN
		ALTER TABLE "decision_triage_events" ADD CONSTRAINT "decision_triage_events_agent_api_key_id_agent_api_keys_id_fk" FOREIGN KEY ("agent_api_key_id") REFERENCES "public"."agent_api_keys"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "decision_queue_items_queue_source_uq" ON "decision_queue_items" USING btree ("queue_id","source_kind","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_queue_items_company_source_idx" ON "decision_queue_items" USING btree ("company_id","source_kind","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "decision_queues_company_key_uq" ON "decision_queues" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_queues_company_updated_idx" ON "decision_queues" USING btree ("company_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "decision_triage_company_source_uq" ON "decision_triage" USING btree ("company_id","source_kind","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_triage_company_decide_by_idx" ON "decision_triage" USING btree ("company_id","decide_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_triage_events_company_source_created_idx" ON "decision_triage_events" USING btree ("company_id","source_kind","source_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_triage_events_queue_created_idx" ON "decision_triage_events" USING btree ("queue_id","created_at");
