CREATE TABLE "formal_qa_checkouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"preparation_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"project_workspace_id" uuid NOT NULL,
	"repository" text NOT NULL,
	"repo_root" text NOT NULL,
	"checkout_path" text NOT NULL,
	"head_sha" text NOT NULL,
	"tree_sha" text NOT NULL,
	"checkout_sha256" text NOT NULL,
	"status" text DEFAULT 'verified' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "formal_qa_checkouts" ADD CONSTRAINT "formal_qa_checkouts_preparation_id_formal_qa_preparations_id_fk" FOREIGN KEY ("preparation_id") REFERENCES "public"."formal_qa_preparations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formal_qa_checkouts" ADD CONSTRAINT "formal_qa_checkouts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formal_qa_checkouts" ADD CONSTRAINT "formal_qa_checkouts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formal_qa_checkouts" ADD CONSTRAINT "formal_qa_checkouts_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "formal_qa_checkouts_preparation_uq" ON "formal_qa_checkouts" USING btree ("preparation_id");--> statement-breakpoint
CREATE INDEX "formal_qa_checkouts_company_project_created_idx" ON "formal_qa_checkouts" USING btree ("company_id","project_id","created_at");