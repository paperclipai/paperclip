CREATE TABLE "oauth_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"status" text NOT NULL,
	"account_id" text,
	"account_label" text,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"access_token_secret_id" uuid NOT NULL,
	"refresh_token_secret_id" uuid,
	"access_token_expires_at" timestamp with time zone,
	"last_refreshed_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"refresh_attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_connections_status_check" CHECK ("oauth_connections"."status" IN ('active','expired','revoked','error'))
);
--> statement-breakpoint
CREATE TABLE "oauth_authorization_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"code_verifier" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"scopes_requested" text[] DEFAULT '{}' NOT NULL,
	"initiated_by_user_id" text,
	"return_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_access_token_secret_id_company_secrets_id_fk" FOREIGN KEY ("access_token_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_refresh_token_secret_id_company_secrets_id_fk" FOREIGN KEY ("refresh_token_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_states" ADD CONSTRAINT "oauth_authorization_states_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_states" ADD CONSTRAINT "oauth_authorization_states_initiated_by_user_id_user_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_connections_company_provider_uq" ON "oauth_connections" USING btree ("company_id","provider_id");--> statement-breakpoint
CREATE INDEX "oauth_connections_refresh_idx" ON "oauth_connections" USING btree ("access_token_expires_at") WHERE "oauth_connections"."status" = 'active' AND "oauth_connections"."refresh_token_secret_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "oauth_authorization_states_expiry_idx" ON "oauth_authorization_states" USING btree ("expires_at") WHERE "oauth_authorization_states"."consumed_at" IS NULL;
