DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'document_revisions_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "document_revisions" DROP CONSTRAINT "document_revisions_company_id_companies_id_fk";
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'document_revisions_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'documents_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "documents" DROP CONSTRAINT "documents_company_id_companies_id_fk";
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'documents_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "documents" ADD CONSTRAINT "documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
