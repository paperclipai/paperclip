CREATE TABLE "company_objectives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"objective_type" text DEFAULT 'quarterly' NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"target_metric" text,
	"target_value" numeric,
	"current_value" numeric DEFAULT '0',
	"proposed_by" uuid,
	"approved_by" text,
	"deadline" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "key_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"objective_id" uuid NOT NULL,
	"title" text NOT NULL,
	"target_value" numeric NOT NULL,
	"current_value" numeric DEFAULT '0',
	"assigned_to" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_objectives" ADD CONSTRAINT "company_objectives_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "company_objectives" ADD CONSTRAINT "company_objectives_proposed_by_agents_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "key_results" ADD CONSTRAINT "key_results_objective_id_company_objectives_id_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."company_objectives"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "key_results" ADD CONSTRAINT "key_results_assigned_to_agents_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "company_objectives_company_idx" ON "company_objectives" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "key_results_objective_idx" ON "key_results" USING btree ("objective_id");
