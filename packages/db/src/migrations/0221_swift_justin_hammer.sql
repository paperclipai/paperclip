CREATE TABLE "claude_setup_token_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"company_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"adapter_type" text NOT NULL,
	"environment_id" uuid NOT NULL,
	"lease_id" text,
	"state" text DEFAULT 'starting' NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"bound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claude_setup_token_sessions" ADD CONSTRAINT "claude_setup_token_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claude_setup_token_sessions" ADD CONSTRAINT "claude_setup_token_sessions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "claude_setup_token_sessions_active_uq" ON "claude_setup_token_sessions" USING btree ("company_id","owner_user_id","adapter_type","environment_id") WHERE "claude_setup_token_sessions"."state" IN ('starting', 'awaiting_code', 'submitting', 'persisting');--> statement-breakpoint
CREATE UNIQUE INDEX "claude_setup_token_sessions_session_id_uq" ON "claude_setup_token_sessions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "claude_setup_token_sessions_deadline_idx" ON "claude_setup_token_sessions" USING btree ("deadline_at");
