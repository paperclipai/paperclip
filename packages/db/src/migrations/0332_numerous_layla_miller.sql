CREATE TABLE "external_agent_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"assignment_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"binding_generation" integer NOT NULL,
	"run_id" uuid NOT NULL,
	"worker_unknown" boolean DEFAULT true NOT NULL,
	"native_effects_unknown" boolean DEFAULT false NOT NULL,
	"stop_boundary" jsonb,
	"worker_reported_at" timestamp with time zone,
	"operator_attested_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "muse_agent_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"operator_id" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pairing' NOT NULL,
	"ticket_hash" text,
	"ticket_expires_at" timestamp with time zone,
	"paired_at" timestamp with time zone,
	"challenge_hash" text,
	"challenge_expires_at" timestamp with time zone,
	"verified_reply_at" timestamp with time zone,
	"receiver_contact_at" timestamp with time zone,
	"worker_activity_at" timestamp with time zone,
	"client_version" text,
	"worker_cursor" integer DEFAULT 0 NOT NULL,
	"qualification_id" uuid,
	"qualification_expires_at" timestamp with time zone,
	"cleanup_expires_at" timestamp with time zone,
	"detector_removed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "muse_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"binding_generation" integer NOT NULL,
	"kind" text NOT NULL,
	"family_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "muse_idle_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"binding_generation" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"outcome" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "muse_input_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"input_digest" text NOT NULL,
	"response" jsonb NOT NULL,
	"source_event_id" text NOT NULL,
	"consumed_at" timestamp with time zone,
	"continuation_receipt_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "muse_mailbox_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"binding_generation" integer NOT NULL,
	"assignment_id" uuid,
	"kind" text NOT NULL,
	"source_event_id" text NOT NULL,
	"references" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "muse_receiver_contact_buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"binding_generation" integer NOT NULL,
	"replica_id" uuid NOT NULL,
	"bucket_at" timestamp with time zone NOT NULL,
	"first_at" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	"contacts" integer NOT NULL,
	"gaps_at_most_seven_seconds" integer NOT NULL,
	"max_gap_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "muse_runner_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"binding_generation" integer NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"normalized_session_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"controller_generation" integer NOT NULL,
	"catalog_digest" text NOT NULL,
	"status" text NOT NULL,
	"projection" jsonb NOT NULL,
	"accept_by" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"offered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"native_accepted_at" timestamp with time zone,
	"accepted_result_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "muse_runner_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"command" jsonb NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"outcome" jsonb,
	"source_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "external_agent_holds" ADD CONSTRAINT "external_agent_holds_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_agent_holds" ADD CONSTRAINT "external_agent_holds_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muse_agent_bindings" ADD CONSTRAINT "muse_agent_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muse_agent_bindings" ADD CONSTRAINT "muse_agent_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muse_credentials" ADD CONSTRAINT "muse_credentials_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muse_credentials" ADD CONSTRAINT "muse_credentials_binding_id_muse_agent_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."muse_agent_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muse_idle_receipts" ADD CONSTRAINT "muse_idle_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muse_idle_receipts" ADD CONSTRAINT "muse_idle_receipts_binding_id_muse_agent_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."muse_agent_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muse_input_deliveries" ADD CONSTRAINT "muse_input_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muse_input_deliveries" ADD CONSTRAINT "muse_input_deliveries_assignment_id_muse_runner_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."muse_runner_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muse_mailbox_items" ADD CONSTRAINT "muse_mailbox_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muse_mailbox_items" ADD CONSTRAINT "muse_mailbox_items_binding_id_muse_agent_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."muse_agent_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muse_mailbox_items" ADD CONSTRAINT "muse_mailbox_items_assignment_id_muse_runner_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."muse_runner_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muse_receiver_contact_buckets" ADD CONSTRAINT "muse_receiver_contact_buckets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muse_receiver_contact_buckets" ADD CONSTRAINT "muse_receiver_contact_buckets_binding_id_muse_agent_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."muse_agent_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muse_runner_assignments" ADD CONSTRAINT "muse_runner_assignments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muse_runner_assignments" ADD CONSTRAINT "muse_runner_assignments_binding_id_muse_agent_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."muse_agent_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muse_runner_assignments" ADD CONSTRAINT "muse_runner_assignments_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muse_runner_assignments" ADD CONSTRAINT "muse_runner_assignments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muse_runner_operations" ADD CONSTRAINT "muse_runner_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muse_runner_operations" ADD CONSTRAINT "muse_runner_operations_assignment_id_muse_runner_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."muse_runner_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_holds_assignment_uq" ON "external_agent_holds" USING btree ("provider","assignment_id");--> statement-breakpoint
CREATE INDEX "external_holds_agent_idx" ON "external_agent_holds" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "muse_bindings_active_agent_uq" ON "muse_agent_bindings" USING btree ("company_id","agent_id") WHERE "muse_agent_bindings"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "muse_bindings_ticket_uq" ON "muse_agent_bindings" USING btree ("ticket_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "muse_credentials_hash_uq" ON "muse_credentials" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "muse_credentials_binding_idx" ON "muse_credentials" USING btree ("binding_id","binding_generation");--> statement-breakpoint
CREATE UNIQUE INDEX "muse_idle_receipts_request_uq" ON "muse_idle_receipts" USING btree ("binding_id","binding_generation","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "muse_input_request_uq" ON "muse_input_deliveries" USING btree ("assignment_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "muse_input_source_uq" ON "muse_input_deliveries" USING btree ("assignment_id","source_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "muse_mailbox_event_uq" ON "muse_mailbox_items" USING btree ("binding_id","binding_generation","source_event_id");--> statement-breakpoint
CREATE INDEX "muse_mailbox_cursor_idx" ON "muse_mailbox_items" USING btree ("binding_id","binding_generation","id");--> statement-breakpoint
CREATE UNIQUE INDEX "muse_contact_bucket_uq" ON "muse_receiver_contact_buckets" USING btree ("binding_id","binding_generation","replica_id","bucket_at");--> statement-breakpoint
CREATE UNIQUE INDEX "muse_assignments_turn_uq" ON "muse_runner_assignments" USING btree ("run_id","turn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "muse_assignments_live_binding_uq" ON "muse_runner_assignments" USING btree ("binding_id") WHERE "muse_runner_assignments"."status" IN ('offered','claimed','accepted');--> statement-breakpoint
CREATE INDEX "muse_assignments_company_idx" ON "muse_runner_assignments" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "muse_operations_request_uq" ON "muse_runner_operations" USING btree ("assignment_id","request_id");