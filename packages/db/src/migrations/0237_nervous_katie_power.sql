CREATE TABLE "formal_qa_preparations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"project_workspace_id" uuid NOT NULL,
	"repository" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"base_ref" text NOT NULL,
	"base_sha" text NOT NULL,
	"tree_sha" text NOT NULL,
	"evidence_sha256" text NOT NULL,
	"issuer_receipt_sha256" text NOT NULL,
	"issuer_operation_id" text NOT NULL,
	"issued_by_user_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_sha256" text NOT NULL,
	"status" text DEFAULT 'prepared' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "formal_qa_preparations" ADD CONSTRAINT "formal_qa_preparations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formal_qa_preparations" ADD CONSTRAINT "formal_qa_preparations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formal_qa_preparations" ADD CONSTRAINT "formal_qa_preparations_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "formal_qa_preparations_company_idempotency_uq" ON "formal_qa_preparations" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "formal_qa_preparations_company_project_created_idx" ON "formal_qa_preparations" USING btree ("company_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "formal_qa_preparations_company_pr_head_idx" ON "formal_qa_preparations" USING btree ("company_id","repository","pr_number","head_sha");