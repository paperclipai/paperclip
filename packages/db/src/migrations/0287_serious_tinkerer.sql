-- Retain preview instruction rows and pending captures when upgrading PR #14325.
CREATE TABLE IF NOT EXISTS "agent_instruction_heads" (
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"entry_file" text NOT NULL,
	"revision_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_instruction_heads_identity_uq" UNIQUE("company_id","agent_id","entry_file")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_instruction_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"entry_file" text NOT NULL,
	"content_base64" text NOT NULL,
	"content_hash" text NOT NULL,
	"byte_length" integer NOT NULL,
	"parent_revision_id" uuid,
	"base_revision_id" uuid,
	"restored_from_revision_id" uuid,
	"actor_agent_id" uuid,
	"actor_user_id" text,
	"responsible_user_id" text,
	"source_run_id" uuid,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_instruction_revisions_identity_uq" UNIQUE("company_id","agent_id","entry_file","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_instruction_working_copies" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"responsible_user_id" text NOT NULL,
	"entry_file" text NOT NULL,
	"base_revision_id" uuid,
	"base_hash" text NOT NULL,
	"local_root" text NOT NULL,
	"execution_root" text NOT NULL,
	"location" text NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"candidate_base64" text,
	"candidate_hash" text,
	"error_code" text,
	"error_message" text,
	"receipt" jsonb,
	"process_stopped_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "agent_instruction_heads" ADD CONSTRAINT "agent_instruction_heads_company_id_agent_id_entry_file_revision_id_agent_instruction_revisions_company_id_agent_id_entry_file_id_fk" FOREIGN KEY ("company_id","agent_id","entry_file","revision_id") REFERENCES "public"."agent_instruction_revisions"("company_id","agent_id","entry_file","id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "agent_instruction_revisions" ADD CONSTRAINT "agent_instruction_revisions_company_id_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "agent_instruction_working_copies" ADD CONSTRAINT "agent_instruction_working_copies_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "agent_instruction_working_copies" ADD CONSTRAINT "agent_instruction_working_copies_company_id_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_instruction_revisions_history_idx" ON "agent_instruction_revisions" USING btree ("company_id","agent_id","entry_file","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_instruction_copies_pending_idx" ON "agent_instruction_working_copies" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_instruction_copies_agent_idx" ON "agent_instruction_working_copies" USING btree ("company_id","agent_id","created_at");
