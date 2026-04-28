CREATE TABLE "rt2_v33_domain_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"event_version" integer DEFAULT 1 NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"command_id" text,
	"correlation_id" text,
	"causation_id" uuid,
	"idempotency_key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rt2_v33_domain_events_actor_type_check" CHECK ("rt2_v33_domain_events"."actor_type" in ('user', 'agent', 'system', 'runtime'))
);
--> statement-breakpoint
CREATE TABLE "rt2_v33_projector_state" (
	"projector_name" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"last_event_id" uuid,
	"last_processed_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rt2_v33_projector_state_status_check" CHECK ("rt2_v33_projector_state"."status" in ('idle', 'running', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "rt2_v33_projector_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"projector_name" text NOT NULL,
	"event_id" uuid NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rt2_v33_projector_events_status_check" CHECK ("rt2_v33_projector_events"."status" in ('processed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "rt2_v33_domain_events" ADD CONSTRAINT "rt2_v33_domain_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rt2_v33_projector_events" ADD CONSTRAINT "rt2_v33_projector_events_event_id_rt2_v33_domain_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."rt2_v33_domain_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rt2_v33_domain_events_company_occurred_idx" ON "rt2_v33_domain_events" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE INDEX "rt2_v33_domain_events_company_type_occurred_idx" ON "rt2_v33_domain_events" USING btree ("company_id","event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "rt2_v33_domain_events_entity_idx" ON "rt2_v33_domain_events" USING btree ("company_id","entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rt2_v33_domain_events_company_idempotency_uq" ON "rt2_v33_domain_events" USING btree ("company_id","idempotency_key") WHERE "rt2_v33_domain_events"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "rt2_v33_projector_events_projector_event_uq" ON "rt2_v33_projector_events" USING btree ("projector_name","event_id");--> statement-breakpoint
CREATE INDEX "rt2_v33_projector_events_event_idx" ON "rt2_v33_projector_events" USING btree ("event_id");
