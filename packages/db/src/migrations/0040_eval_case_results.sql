ALTER TABLE "eval_results" ADD COLUMN "skipped" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "eval_results" ADD COLUMN "total_cost_cents" integer NOT NULL DEFAULT 0;--> statement-breakpoint
CREATE TABLE "eval_case_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"eval_result_id" uuid NOT NULL,
	"bundle_id" text NOT NULL,
	"case_id" text NOT NULL,
	"case_name" text NOT NULL,
	"status" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"token_count" integer,
	"cost_cents" integer,
	"run_id" text,
	"output" text,
	"failed_expectations" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_case_results" ADD CONSTRAINT "eval_case_results_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_case_results" ADD CONSTRAINT "eval_case_results_eval_result_id_eval_results_id_fk" FOREIGN KEY ("eval_result_id") REFERENCES "public"."eval_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_case_results_company_created_idx" ON "eval_case_results" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "eval_case_results_eval_result_idx" ON "eval_case_results" USING btree ("eval_result_id");--> statement-breakpoint
CREATE INDEX "eval_case_results_bundle_case_idx" ON "eval_case_results" USING btree ("bundle_id","case_id");
