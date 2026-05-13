ALTER TABLE "plugin_entities" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "plugin_job_runs" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "plugin_logs" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "plugin_webhook_deliveries" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "plugin_entities" ADD CONSTRAINT "plugin_entities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_job_runs" ADD CONSTRAINT "plugin_job_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_logs" ADD CONSTRAINT "plugin_logs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_webhook_deliveries" ADD CONSTRAINT "plugin_webhook_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_entities_company_idx" ON "plugin_entities" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_job_runs_company_idx" ON "plugin_job_runs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_logs_company_idx" ON "plugin_logs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_webhook_deliveries_company_idx" ON "plugin_webhook_deliveries" USING btree ("company_id");