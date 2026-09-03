CREATE TABLE "cloud_runtime_identity" (
	"singleton_key" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"stack_id" text NOT NULL,
	"claim_id" text NOT NULL,
	"previous_origin" text NOT NULL,
	"canonical_origin" text NOT NULL,
	"stack_slug" text NOT NULL,
	"applied_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
