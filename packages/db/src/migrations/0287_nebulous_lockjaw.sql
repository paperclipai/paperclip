CREATE TABLE "native_authority_work" (
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"normalized_session_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"collection" text NOT NULL,
	"work_id" text NOT NULL,
	"body" text NOT NULL,
	"body_sha256" text NOT NULL,
	CONSTRAINT "native_authority_work_company_id_normalized_session_id_collection_work_id_pk" PRIMARY KEY("company_id","normalized_session_id","collection","work_id"),
	CONSTRAINT "native_authority_work_body_bound" CHECK (octet_length("native_authority_work"."body") <= 16384),
	CONSTRAINT "native_authority_work_collection_valid" CHECK ("native_authority_work"."collection" = 'process-owner')
);
--> statement-breakpoint
ALTER TABLE "native_authority_work" ADD CONSTRAINT "native_authority_work_authority_owner_fk" FOREIGN KEY ("company_id","issue_id","normalized_session_id","run_id") REFERENCES "public"."native_session_authorities"("company_id","issue_id","normalized_session_id","run_id") ON DELETE cascade ON UPDATE no action;