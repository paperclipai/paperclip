CREATE TABLE "user_llm_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider_type" text NOT NULL,
	"encrypted_payload" jsonb NOT NULL,
	"key_fingerprint" text,
	"base_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"tested_at" timestamp with time zone,
	"test_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_llm_creds_user_provider_idx" UNIQUE("user_id","provider_type")
);
--> statement-breakpoint
CREATE INDEX "user_llm_creds_user_id_idx" ON "user_llm_credentials" ("user_id");--> statement-breakpoint
CREATE TABLE "llm_model_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_type" text NOT NULL,
	"model_id" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_model_cache_provider_model_idx" UNIQUE("provider_type","model_id")
);
