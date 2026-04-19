CREATE TABLE "project_labels" (
	"project_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_labels_pk" PRIMARY KEY("project_id","label_id")
);
--> statement-breakpoint
ALTER TABLE "project_labels" ADD CONSTRAINT "project_labels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_labels" ADD CONSTRAINT "project_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_labels" ADD CONSTRAINT "project_labels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_labels_project_idx" ON "project_labels" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_labels_label_idx" ON "project_labels" USING btree ("label_id");--> statement-breakpoint
CREATE INDEX "project_labels_company_idx" ON "project_labels" USING btree ("company_id");