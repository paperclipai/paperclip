CREATE TABLE IF NOT EXISTS "provider_rate_limit_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"adapter_type" text NOT NULL,
	"limit_kind" text NOT NULL,
	"model_family" text,
	"message" text,
	"resets_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_rate_limit_blocks_company_id_companies_id_fk') THEN
  ALTER TABLE "provider_rate_limit_blocks" ADD CONSTRAINT "provider_rate_limit_blocks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_rate_limit_blocks_company_adapter_idx" ON "provider_rate_limit_blocks" USING btree ("company_id","adapter_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_rate_limit_blocks_resolved_idx" ON "provider_rate_limit_blocks" USING btree ("company_id","adapter_type","resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_rate_limit_blocks_active_idx"
  ON "provider_rate_limit_blocks" USING btree ("company_id","adapter_type","limit_kind",COALESCE("model_family",''))
  WHERE resolved_at IS NULL;
