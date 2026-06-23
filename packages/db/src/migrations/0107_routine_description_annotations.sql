CREATE TABLE IF NOT EXISTS "routine_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'routine_documents_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "routine_documents" ADD CONSTRAINT "routine_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'routine_documents_routine_id_routines_id_fk'
	) THEN
		ALTER TABLE "routine_documents" ADD CONSTRAINT "routine_documents_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'routine_documents_document_id_documents_id_fk'
	) THEN
		ALTER TABLE "routine_documents" ADD CONSTRAINT "routine_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "routine_documents_company_routine_key_uq" ON "routine_documents" USING btree ("company_id","routine_id","key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "routine_documents_document_uq" ON "routine_documents" USING btree ("document_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_documents_company_routine_updated_idx" ON "routine_documents" USING btree ("company_id","routine_id","updated_at");
--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD COLUMN IF NOT EXISTS "routine_id" uuid;
--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD COLUMN IF NOT EXISTS "routine_id" uuid;
--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ALTER COLUMN "issue_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ALTER COLUMN "issue_id" DROP NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'document_annotation_threads_routine_id_routines_id_fk'
	) THEN
		ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'document_annotation_comments_routine_id_routines_id_fk'
	) THEN
		ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_annotation_threads_company_routine_status_idx" ON "document_annotation_threads" USING btree ("company_id","routine_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_annotation_comments_company_routine_created_at_idx" ON "document_annotation_comments" USING btree ("company_id","routine_id","created_at");
--> statement-breakpoint
DO $$
DECLARE
	routine_row RECORD;
	created_document_id uuid;
	created_revision_id uuid;
BEGIN
	FOR routine_row IN
		SELECT *
		FROM "routines"
		WHERE NOT EXISTS (
			SELECT 1
			FROM "routine_documents"
			WHERE "routine_documents"."routine_id" = "routines"."id"
				AND "routine_documents"."key" = 'description'
		)
	LOOP
		INSERT INTO "documents" (
			"company_id",
			"title",
			"format",
			"latest_body",
			"latest_revision_number",
			"created_by_agent_id",
			"created_by_user_id",
			"updated_by_agent_id",
			"updated_by_user_id",
			"created_at",
			"updated_at"
		)
		VALUES (
			routine_row."company_id",
			'routine description',
			'markdown',
			coalesce(routine_row."description", ''),
			1,
			routine_row."created_by_agent_id",
			routine_row."created_by_user_id",
			routine_row."updated_by_agent_id",
			routine_row."updated_by_user_id",
			coalesce(routine_row."created_at", now()),
			coalesce(routine_row."updated_at", now())
		)
		RETURNING "id" INTO created_document_id;

		INSERT INTO "document_revisions" (
			"company_id",
			"document_id",
			"revision_number",
			"title",
			"format",
			"body",
			"change_summary",
			"created_by_agent_id",
			"created_by_user_id",
			"created_at"
		)
		VALUES (
			routine_row."company_id",
			created_document_id,
			1,
			'routine description',
			'markdown',
			coalesce(routine_row."description", ''),
			'Backfilled routine description',
			routine_row."created_by_agent_id",
			routine_row."created_by_user_id",
			coalesce(routine_row."created_at", now())
		)
		RETURNING "id" INTO created_revision_id;

		UPDATE "documents"
		SET "latest_revision_id" = created_revision_id
		WHERE "id" = created_document_id;

		INSERT INTO "routine_documents" ("company_id", "routine_id", "document_id", "key", "created_at", "updated_at")
		VALUES (
			routine_row."company_id",
			routine_row."id",
			created_document_id,
			'description',
			coalesce(routine_row."created_at", now()),
			coalesce(routine_row."updated_at", now())
		)
		ON CONFLICT DO NOTHING;
	END LOOP;
END $$;
