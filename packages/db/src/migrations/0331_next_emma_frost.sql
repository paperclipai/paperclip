CREATE TABLE "computers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"provider" text DEFAULT 'boat' NOT NULL,
	"provider_id" text NOT NULL,
	"ledger" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "computers_physical_uq" ON "computers" USING btree ("provider","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "computers_environment_uq" ON "computers" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "computers_company_idx" ON "computers" USING btree ("company_id");