CREATE TABLE IF NOT EXISTS "dispatch_gate_state" (
	"scope_key" text PRIMARY KEY NOT NULL,
	"ownership_state" text DEFAULT 'idle' NOT NULL,
	"owner_kind" text,
	"owner_id" text,
	"blocked_until" timestamp with time zone,
	"operator_resume_required" boolean DEFAULT false NOT NULL,
	"block_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
