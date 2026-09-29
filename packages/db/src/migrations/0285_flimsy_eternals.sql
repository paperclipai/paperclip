ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_company_id_run_id_uq" UNIQUE("company_id","id");--> statement-breakpoint
CREATE TABLE "native_authority_records" (
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"normalized_session_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"record_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"body" text NOT NULL,
	"body_sha256" text NOT NULL,
	CONSTRAINT "native_authority_records_company_id_normalized_session_id_run_id_kind_record_id_pk" PRIMARY KEY("company_id","normalized_session_id","run_id","kind","record_id"),
	CONSTRAINT "native_authority_records_sequence_uq" UNIQUE("company_id","normalized_session_id","run_id","kind","sequence"),
	CONSTRAINT "native_authority_records_body_bound" CHECK (octet_length("native_authority_records"."body") <= 1048576),
	CONSTRAINT "native_authority_records_kind_valid" CHECK ("native_authority_records"."kind" in ('command', 'event', 'effect')),
	CONSTRAINT "native_authority_records_sequence_positive" CHECK ("native_authority_records"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "native_session_authorities" (
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"normalized_session_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"successor_run_id" uuid,
	"binding" text NOT NULL,
	"generation" bigint NOT NULL,
	"state" text NOT NULL,
	"state_sha256" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_session_authorities_company_id_normalized_session_id_run_id_pk" PRIMARY KEY("company_id","normalized_session_id","run_id"),
	CONSTRAINT "native_session_authorities_owner_uq" UNIQUE("company_id","issue_id","normalized_session_id","run_id"),
	CONSTRAINT "native_session_authorities_state_bound" CHECK (octet_length("native_session_authorities"."state") <= 16777216),
	CONSTRAINT "native_session_authorities_generation_positive" CHECK ("native_session_authorities"."generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "native_source_cursors" (
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source_instance_id" text NOT NULL,
	"cursor" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "native_source_cursors_run_id_source_instance_id_pk" PRIMARY KEY("run_id","source_instance_id"),
	CONSTRAINT "native_source_cursors_cursor_positive" CHECK ("native_source_cursors"."cursor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "native_authority_records" ADD CONSTRAINT "native_authority_records_authority_owner_fk" FOREIGN KEY ("company_id","issue_id","normalized_session_id","run_id") REFERENCES "public"."native_session_authorities"("company_id","issue_id","normalized_session_id","run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_authority_records" ADD CONSTRAINT "native_authority_records_run_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id") REFERENCES "public"."heartbeat_runs"("company_id","native_issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_session_authorities" ADD CONSTRAINT "native_session_authorities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_session_authorities" ADD CONSTRAINT "native_session_authorities_issue_owner_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_session_authorities" ADD CONSTRAINT "native_session_authorities_run_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id") REFERENCES "public"."heartbeat_runs"("company_id","native_issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_source_cursors" ADD CONSTRAINT "native_source_cursors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_source_cursors" ADD CONSTRAINT "native_source_cursors_run_owner_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."heartbeat_runs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
