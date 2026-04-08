CREATE TABLE "team_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "team_documents" ADD CONSTRAINT "team_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_documents" ADD CONSTRAINT "team_documents_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_documents" ADD CONSTRAINT "team_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "team_documents_company_team_key_uq" ON "team_documents" USING btree ("company_id","team_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "team_documents_document_uq" ON "team_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "team_documents_company_team_updated_idx" ON "team_documents" USING btree ("company_id","team_id","updated_at");
