CREATE TABLE IF NOT EXISTS "claude_auth_switch_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"from_profile" text,
	"to_profile" text,
	"target_tier" text,
	"applied" boolean DEFAULT false NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"candidates" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claude_auth_switch_decision_decided_at_idx" ON "claude_auth_switch_decision" USING btree ("decided_at");
