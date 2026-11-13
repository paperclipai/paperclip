CREATE TABLE "tailscale_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"secret_id" uuid,
	"created_by_user_id" text NOT NULL,
	"oauth_state_hash" text,
	"oauth_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tailscale_connections" ADD CONSTRAINT "tailscale_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tailscale_connections" ADD CONSTRAINT "tailscale_connections_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tailscale_connections_company_idx" ON "tailscale_connections" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tailscale_connections_oauth_state_idx" ON "tailscale_connections" USING btree ("oauth_state_hash");