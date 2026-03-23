CREATE TABLE "products" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "status" text DEFAULT 'active' NOT NULL,
  "product_type" text DEFAULT 'newsletter' NOT NULL,
  "primary_channel" text DEFAULT 'email' NOT NULL,
  "product_url" text,
  "landing_path" text,
  "health_path" text,
  "owner_agent_id" uuid,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action,
  CONSTRAINT "products_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "products_company_idx" ON "products" USING btree ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "products_company_slug_idx" ON "products" USING btree ("company_id", "slug");
--> statement-breakpoint
ALTER TABLE "newsletter_subscribers" ADD COLUMN "product_id" uuid;
--> statement-breakpoint
ALTER TABLE "newsletter_subscribers" ADD CONSTRAINT "newsletter_subscribers_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_metrics_snapshots" ADD COLUMN "product_id" uuid;
--> statement-breakpoint
ALTER TABLE "user_metrics_snapshots" ADD CONSTRAINT "user_metrics_snapshots_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "product_health_checks" ADD COLUMN "product_id" uuid;
--> statement-breakpoint
ALTER TABLE "product_health_checks" ADD CONSTRAINT "product_health_checks_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DROP INDEX IF EXISTS "user_metrics_snapshots_company_date_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "user_metrics_snapshots_company_date_idx" ON "user_metrics_snapshots" USING btree ("company_id", "product_id", "snapshot_date");
