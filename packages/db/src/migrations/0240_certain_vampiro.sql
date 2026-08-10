CREATE TABLE "company_github_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"hostname" text DEFAULT 'github.com' NOT NULL,
	"secret_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"account_login" text,
	"last_tested_at" timestamp with time zone,
	"last_test_status" text,
	"last_test_message" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "github_connection_id" uuid;
--> statement-breakpoint
ALTER TABLE "company_github_connections" ADD CONSTRAINT "company_github_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "company_github_connections" ADD CONSTRAINT "company_github_connections_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_github_connection_id_company_github_connections_id_fk" FOREIGN KEY ("github_connection_id") REFERENCES "public"."company_github_connections"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "company_github_connections_company_idx" ON "company_github_connections" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "company_github_connections_secret_idx" ON "company_github_connections" USING btree ("secret_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "company_github_connections_company_name_uq" ON "company_github_connections" USING btree ("company_id","name");
--> statement-breakpoint
CREATE INDEX "projects_github_connection_idx" ON "projects" USING btree ("github_connection_id");
