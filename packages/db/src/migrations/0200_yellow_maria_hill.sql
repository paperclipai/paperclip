CREATE TABLE IF NOT EXISTS "decision_archive_notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"archive_version" integer NOT NULL,
	"origin_agent_id" uuid NOT NULL,
	"origin_issue_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_archive_notification_outbox_status_check" CHECK ("decision_archive_notification_outbox"."status" IN ('pending', 'delivering', 'delivered'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decision_retention" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"source_activity_at" timestamp with time zone NOT NULL,
	"keep" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_reason" text,
	"archived_by_type" text,
	"archived_by_agent_id" uuid,
	"archived_by_user_id" text,
	"archived_by_run_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"archive_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_retention_archive_actor_check" CHECK ((
        ("decision_retention"."archived_at" IS NULL AND "decision_retention"."archived_by_type" IS NULL AND "decision_retention"."archived_by_agent_id" IS NULL AND "decision_retention"."archived_by_user_id" IS NULL)
        OR ("decision_retention"."archived_at" IS NOT NULL AND "decision_retention"."archived_by_type" = 'system' AND "decision_retention"."archived_by_agent_id" IS NULL AND "decision_retention"."archived_by_user_id" IS NULL)
        OR ("decision_retention"."archived_at" IS NOT NULL AND "decision_retention"."archived_by_type" = 'agent' AND "decision_retention"."archived_by_agent_id" IS NOT NULL AND "decision_retention"."archived_by_user_id" IS NULL)
        OR ("decision_retention"."archived_at" IS NOT NULL AND "decision_retention"."archived_by_type" = 'user' AND "decision_retention"."archived_by_agent_id" IS NULL AND "decision_retention"."archived_by_user_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_archive_notification_outbox_company_id_companies_id_fk' AND conrelid = 'public.decision_archive_notification_outbox'::regclass) THEN
		ALTER TABLE "decision_archive_notification_outbox" ADD CONSTRAINT "decision_archive_notification_outbox_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_archive_notification_outbox_origin_agent_id_agents_id_fk' AND conrelid = 'public.decision_archive_notification_outbox'::regclass) THEN
		ALTER TABLE "decision_archive_notification_outbox" ADD CONSTRAINT "decision_archive_notification_outbox_origin_agent_id_agents_id_fk" FOREIGN KEY ("origin_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_retention_company_id_companies_id_fk' AND conrelid = 'public.decision_retention'::regclass) THEN
		ALTER TABLE "decision_retention" ADD CONSTRAINT "decision_retention_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_retention_archived_by_agent_id_agents_id_fk' AND conrelid = 'public.decision_retention'::regclass) THEN
		ALTER TABLE "decision_retention" ADD CONSTRAINT "decision_retention_archived_by_agent_id_agents_id_fk" FOREIGN KEY ("archived_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_retention_archived_by_run_id_heartbeat_runs_id_fk' AND conrelid = 'public.decision_retention'::regclass) THEN
		ALTER TABLE "decision_retention" ADD CONSTRAINT "decision_retention_archived_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("archived_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "decision_archive_notification_outbox_uq" ON "decision_archive_notification_outbox" USING btree ("company_id","source_kind","source_id","archive_version","origin_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_archive_notification_outbox_pending_idx" ON "decision_archive_notification_outbox" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "decision_retention_company_source_uq" ON "decision_retention" USING btree ("company_id","source_kind","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_retention_company_archived_idx" ON "decision_retention" USING btree ("company_id","archived_at");
