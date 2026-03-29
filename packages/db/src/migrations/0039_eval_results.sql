CREATE TABLE "eval_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bundle_id" text NOT NULL,
	"bundle_name" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"total_cases" integer NOT NULL,
	"passed" integer NOT NULL,
	"failed" integer NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"result_json" jsonb NOT NULL,
	"duration" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_results_company_created_idx" ON "eval_results" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "eval_results_company_bundle_idx" ON "eval_results" USING btree ("company_id","bundle_id");--> statement-breakpoint
CREATE INDEX "eval_results_company_agent_idx" ON "eval_results" USING btree ("company_id","agent_id");
