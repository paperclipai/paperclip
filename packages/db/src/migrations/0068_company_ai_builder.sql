CREATE TABLE IF NOT EXISTS "builder_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by_user_id" text,
	"title" text DEFAULT '' NOT NULL,
	"provider_type" text NOT NULL,
	"model" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"input_tokens_total" integer DEFAULT 0 NOT NULL,
	"output_tokens_total" integer DEFAULT 0 NOT NULL,
	"cost_cents_total" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "builder_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"role" text NOT NULL,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "builder_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"applied_activity_id" uuid,
	"approval_id" uuid,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "builder_provider_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"provider_type" text NOT NULL,
	"model" text NOT NULL,
	"base_url" text,
	"secret_id" uuid,
	"extras" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "builder_sessions"
	ADD CONSTRAINT "builder_sessions_company_id_companies_id_fk"
	FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "builder_messages"
	ADD CONSTRAINT "builder_messages_session_id_builder_sessions_id_fk"
	FOREIGN KEY ("session_id") REFERENCES "public"."builder_sessions"("id")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "builder_messages"
	ADD CONSTRAINT "builder_messages_company_id_companies_id_fk"
	FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "builder_proposals"
	ADD CONSTRAINT "builder_proposals_session_id_builder_sessions_id_fk"
	FOREIGN KEY ("session_id") REFERENCES "public"."builder_sessions"("id")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "builder_proposals"
	ADD CONSTRAINT "builder_proposals_message_id_builder_messages_id_fk"
	FOREIGN KEY ("message_id") REFERENCES "public"."builder_messages"("id")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "builder_proposals"
	ADD CONSTRAINT "builder_proposals_company_id_companies_id_fk"
	FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "builder_provider_settings"
	ADD CONSTRAINT "builder_provider_settings_company_id_companies_id_fk"
	FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "builder_provider_settings"
	ADD CONSTRAINT "builder_provider_settings_secret_id_company_secrets_id_fk"
	FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id")
	ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_sessions_company_idx" ON "builder_sessions" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_sessions_company_created_idx" ON "builder_sessions" USING btree ("company_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "builder_messages_session_sequence_uq" ON "builder_messages" USING btree ("session_id","sequence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_messages_session_idx" ON "builder_messages" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_messages_company_idx" ON "builder_messages" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_proposals_company_idx" ON "builder_proposals" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_proposals_session_idx" ON "builder_proposals" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_proposals_company_status_idx" ON "builder_proposals" USING btree ("company_id","status");
