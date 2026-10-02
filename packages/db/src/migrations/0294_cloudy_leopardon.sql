CREATE TABLE "pubsub_activity_receipts" (
	"event_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"company_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pubsub_activity_receipts_event_id_topic_pk" PRIMARY KEY("event_id","topic")
);
--> statement-breakpoint
CREATE TABLE "pubsub_messages" (
	"company_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"direction" text NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"from_instance" uuid NOT NULL,
	"from_company" uuid NOT NULL,
	"from_agent" uuid,
	"from_role" text NOT NULL,
	"content_hash" text NOT NULL,
	"envelope" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acked_at" timestamp with time zone,
	"delivery_count" integer DEFAULT 0 NOT NULL,
	"next_visible_at" timestamp with time zone DEFAULT now() NOT NULL,
	"wake_pending" integer DEFAULT 0 NOT NULL,
	"wake_attempts" integer DEFAULT 0 NOT NULL,
	"wake_available_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pubsub_messages_company_id_id_pk" PRIMARY KEY("company_id","id")
);
--> statement-breakpoint
CREATE TABLE "pubsub_nonces" (
	"peer_instance_id" uuid NOT NULL,
	"nonce" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pubsub_nonces_peer_instance_id_nonce_pk" PRIMARY KEY("peer_instance_id","nonce")
);
--> statement-breakpoint
CREATE TABLE "pubsub_observers" (
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pubsub_observers_company_id_agent_id_pk" PRIMARY KEY("company_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "pubsub_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"peer_instance_id" uuid NOT NULL,
	"peer_company_id" uuid NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pubsub_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"peer_instance_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pubsub_trust" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"peer_instance_id" uuid NOT NULL,
	"peer_company_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"url" text NOT NULL,
	"topics" jsonb NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pubsub_activity_receipts" ADD CONSTRAINT "pubsub_activity_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pubsub_messages" ADD CONSTRAINT "pubsub_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pubsub_observers" ADD CONSTRAINT "pubsub_observers_company_id_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pubsub_outbox" ADD CONSTRAINT "pubsub_outbox_company_id_message_id_pubsub_messages_company_id_id_fk" FOREIGN KEY ("company_id","message_id") REFERENCES "public"."pubsub_messages"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pubsub_subscriptions" ADD CONSTRAINT "pubsub_subscriptions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pubsub_trust" ADD CONSTRAINT "pubsub_trust_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pubsub_messages_history_idx" ON "pubsub_messages" USING btree ("company_id","topic","created_at","id");--> statement-breakpoint
CREATE INDEX "pubsub_messages_inbox_idx" ON "pubsub_messages" USING btree ("company_id","direction","acked_at","next_visible_at");--> statement-breakpoint
CREATE INDEX "pubsub_messages_wake_idx" ON "pubsub_messages" USING btree ("wake_pending","wake_available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pubsub_outbox_message_peer_idx" ON "pubsub_outbox" USING btree ("company_id","message_id","peer_instance_id");--> statement-breakpoint
CREATE INDEX "pubsub_outbox_pending_idx" ON "pubsub_outbox" USING btree ("delivered_at","cancelled_at","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pubsub_subscriptions_company_peer_topic_idx" ON "pubsub_subscriptions" USING btree ("company_id","peer_instance_id","topic");--> statement-breakpoint
CREATE UNIQUE INDEX "pubsub_trust_company_peer_idx" ON "pubsub_trust" USING btree ("company_id","peer_instance_id");