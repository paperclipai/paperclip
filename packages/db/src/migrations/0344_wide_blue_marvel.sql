CREATE TABLE "grok_bot_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"binding_generation" integer NOT NULL,
	"grant_id" uuid NOT NULL,
	"routine_revision" integer NOT NULL,
	"assignment_id" uuid,
	"source_event_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"challenge_hash" text,
	"status" text DEFAULT 'prepared' NOT NULL,
	"http_status" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grok_bot_routines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"binding_generation" integer NOT NULL,
	"bot_name" text NOT NULL,
	"secret_id" uuid NOT NULL,
	"secret_version" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"verified_grant_id" uuid,
	"verified_at" timestamp with time zone,
	"last_contact_at" timestamp with time zone,
	"recovery_required_at" timestamp with time zone,
	"recovery_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dot_agent_bindings" ADD COLUMN "provider_kind" text DEFAULT 'openai_dot' NOT NULL;--> statement-breakpoint
ALTER TABLE "dot_runner_operations" ADD COLUMN "pending_returned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dot_runner_operations" ADD COLUMN "observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mcp_attachment_uploads" ADD COLUMN "grant_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_attachment_uploads" ADD COLUMN "work_session_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_file_tickets" ADD COLUMN "work_session_id" uuid;--> statement-breakpoint
ALTER TABLE "grok_bot_dispatches" ADD CONSTRAINT "grok_bot_dispatches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grok_bot_dispatches" ADD CONSTRAINT "grok_bot_dispatches_routine_id_grok_bot_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."grok_bot_routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grok_bot_dispatches" ADD CONSTRAINT "grok_bot_dispatches_binding_id_dot_agent_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."dot_agent_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grok_bot_dispatches" ADD CONSTRAINT "grok_bot_dispatches_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grok_bot_dispatches" ADD CONSTRAINT "grok_bot_dispatches_assignment_id_dot_runner_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."dot_runner_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grok_bot_routines" ADD CONSTRAINT "grok_bot_routines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grok_bot_routines" ADD CONSTRAINT "grok_bot_routines_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grok_bot_routines" ADD CONSTRAINT "grok_bot_routines_binding_id_dot_agent_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."dot_agent_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grok_bot_routines" ADD CONSTRAINT "grok_bot_routines_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grok_bot_routines" ADD CONSTRAINT "grok_bot_routines_verified_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("verified_grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grok_dispatch_event_uq" ON "grok_bot_dispatches" USING btree ("binding_id","binding_generation","routine_revision","source_event_id");--> statement-breakpoint
CREATE INDEX "grok_dispatch_company_status_idx" ON "grok_bot_dispatches" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "grok_routines_binding_uq" ON "grok_bot_routines" USING btree ("binding_id");--> statement-breakpoint
CREATE INDEX "grok_routines_company_agent_idx" ON "grok_bot_routines" USING btree ("company_id","agent_id");--> statement-breakpoint
ALTER TABLE "mcp_attachment_uploads" ADD CONSTRAINT "mcp_attachment_uploads_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;