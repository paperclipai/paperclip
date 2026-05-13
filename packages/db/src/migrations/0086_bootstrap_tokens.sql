CREATE TABLE IF NOT EXISTS "bootstrap_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"job_uid" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bootstrap_tokens_token_hash_idx" ON "bootstrap_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bootstrap_tokens_run_id_idx" ON "bootstrap_tokens" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bootstrap_tokens_expires_idx" ON "bootstrap_tokens" USING btree ("expires_at");
