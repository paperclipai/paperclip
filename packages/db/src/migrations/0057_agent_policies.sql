CREATE TABLE IF NOT EXISTS "agent_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"format" text DEFAULT 'markdown' NOT NULL,
	"latest_body" text DEFAULT '' NOT NULL,
	"latest_revision_id" uuid,
	"latest_revision_number" integer DEFAULT 0 NOT NULL,
	"scope" text DEFAULT 'agent' NOT NULL,
	"scope_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_policy_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"change_summary" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_policies_company_id_companies_id_fk') THEN
  ALTER TABLE "agent_policies" ADD CONSTRAINT "agent_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_policies_agent_id_agents_id_fk') THEN
  ALTER TABLE "agent_policies" ADD CONSTRAINT "agent_policies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_policy_revisions_policy_id_agent_policies_id_fk') THEN
  ALTER TABLE "agent_policy_revisions" ADD CONSTRAINT "agent_policy_revisions_policy_id_agent_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."agent_policies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_policies_agent_key_unique_idx" ON "agent_policies" USING btree ("agent_id","key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_policies_company_agent_active_idx" ON "agent_policies" USING btree ("company_id","agent_id","active");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_policy_revisions_policy_revision_unique_idx" ON "agent_policy_revisions" USING btree ("policy_id","revision_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_policy_revisions_policy_id_idx" ON "agent_policy_revisions" USING btree ("policy_id");
