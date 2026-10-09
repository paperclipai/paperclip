CREATE TABLE "chat_teams_file_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"authorized_user_id" text,
	"runtime_generation" integer NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"conversation_generation" integer NOT NULL,
	"source_digest" text NOT NULL,
	"authority_digest" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bot_app_id" uuid NOT NULL,
	"aad_object_id" uuid NOT NULL,
	"provider_conversation_id" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"filename" text NOT NULL,
	"token_sha256" text NOT NULL,
	"phase" text DEFAULT 'consent_pending' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"attempt_id" uuid,
	"attempt_expires_at" timestamp with time zone,
	"consent_message_id" text,
	"file_info_message_id" text,
	"response_activity_id" text,
	"response_digest" text,
	"private_state" jsonb NOT NULL,
	"reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_teams_file_transfers_phase_check" CHECK ("chat_teams_file_transfers"."phase" in ('consent_pending','consent_sending','consent_unknown','awaiting_consent','upload_pending','uploading','upload_unknown','file_info_pending','file_info_sending','file_info_unknown','delivered','declined','expired','cancelled','conflict')),
	CONSTRAINT "chat_teams_file_transfers_bounds_check" CHECK ("chat_teams_file_transfers"."version" > 0 and "chat_teams_file_transfers"."runtime_generation" >= 0 and "chat_teams_file_transfers"."conversation_generation" > 0 and "chat_teams_file_transfers"."byte_size" > 0 and "chat_teams_file_transfers"."byte_size" < 62914560),
	CONSTRAINT "chat_teams_file_transfers_hash_check" CHECK ("chat_teams_file_transfers"."source_digest" ~ '^[a-f0-9]{64}$' and "chat_teams_file_transfers"."authority_digest" ~ '^[a-f0-9]{64}$' and "chat_teams_file_transfers"."sha256" ~ '^[a-f0-9]{64}$' and "chat_teams_file_transfers"."token_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "chat_teams_file_transfers_attempt_check" CHECK (("chat_teams_file_transfers"."attempt_id" is null) = ("chat_teams_file_transfers"."attempt_expires_at" is null))
);
--> statement-breakpoint
ALTER TABLE "chat_publications" DROP CONSTRAINT "chat_publications_state_check";--> statement-breakpoint
CREATE UNIQUE INDEX "chat_publications_company_id_uq" ON "chat_publications" USING btree ("company_id","id");--> statement-breakpoint
ALTER TABLE "chat_teams_file_transfers" ADD CONSTRAINT "chat_teams_file_transfers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_teams_file_transfers" ADD CONSTRAINT "chat_teams_file_transfers_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_teams_file_transfers" ADD CONSTRAINT "chat_teams_file_transfers_company_id_endpoint_id_chat_endpoints_company_id_id_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_teams_file_transfers" ADD CONSTRAINT "chat_teams_file_transfers_company_id_publication_id_chat_publications_company_id_id_fk" FOREIGN KEY ("company_id","publication_id") REFERENCES "public"."chat_publications"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_teams_file_transfers" ADD CONSTRAINT "chat_teams_file_transfers_company_id_conversation_id_chat_conversations_company_id_id_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."chat_conversations"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_teams_file_transfers" ADD CONSTRAINT "chat_teams_file_transfers_company_id_principal_id_chat_external_principals_company_id_id_fk" FOREIGN KEY ("company_id","principal_id") REFERENCES "public"."chat_external_principals"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_teams_file_transfers_publication_uq" ON "chat_teams_file_transfers" USING btree ("company_id","publication_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_teams_file_transfers_token_uq" ON "chat_teams_file_transfers" USING btree ("endpoint_id","token_sha256");--> statement-breakpoint
CREATE INDEX "chat_teams_file_transfers_work_idx" ON "chat_teams_file_transfers" USING btree ("phase","attempt_expires_at","expires_at");--> statement-breakpoint
ALTER TABLE "chat_publications" ADD CONSTRAINT "chat_publications_state_check" CHECK ("chat_publications"."state" in ('pending', 'streaming', 'published', 'retry', 'delivery_unknown', 'failed', 'cancelled', 'awaiting_consent'));
