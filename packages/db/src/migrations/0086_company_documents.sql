CREATE TABLE "company_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_documents" ADD CONSTRAINT "company_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_documents" ADD CONSTRAINT "company_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_documents_company_key_uq" ON "company_documents" USING btree ("company_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "company_documents_document_uq" ON "company_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "company_documents_company_updated_idx" ON "company_documents" USING btree ("company_id","updated_at");
