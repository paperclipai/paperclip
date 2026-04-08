-- Phase 3a: Mission rooms (rooms, room_participants, room_messages, room_issues)
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"user_id" text,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"sender_agent_id" uuid,
	"sender_user_id" text,
	"type" text NOT NULL,
	"body" text NOT NULL,
	"action_payload" jsonb,
	"action_status" text,
	"action_target_agent_id" uuid,
	"reply_to_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_issues" (
	"room_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"linked_by_user_id" text,
	"linked_by_agent_id" uuid,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_issues_room_id_issue_id_pk" PRIMARY KEY("room_id","issue_id")
);
--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_participants" ADD CONSTRAINT "room_participants_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_participants" ADD CONSTRAINT "room_participants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_participants" ADD CONSTRAINT "room_participants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_messages" ADD CONSTRAINT "room_messages_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_messages" ADD CONSTRAINT "room_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_messages" ADD CONSTRAINT "room_messages_sender_agent_id_agents_id_fk" FOREIGN KEY ("sender_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_messages" ADD CONSTRAINT "room_messages_action_target_agent_id_agents_id_fk" FOREIGN KEY ("action_target_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_messages" ADD CONSTRAINT "room_messages_reply_to_id_room_messages_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."room_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_issues" ADD CONSTRAINT "room_issues_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_issues" ADD CONSTRAINT "room_issues_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_issues" ADD CONSTRAINT "room_issues_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rooms_company_idx" ON "rooms" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "rooms_company_status_idx" ON "rooms" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "room_participants_room_idx" ON "room_participants" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "room_participants_company_idx" ON "room_participants" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_participants_room_agent_uniq" ON "room_participants" USING btree ("room_id","agent_id");--> statement-breakpoint
CREATE INDEX "room_participants_agent_idx" ON "room_participants" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "room_messages_room_created_idx" ON "room_messages" USING btree ("room_id","created_at");--> statement-breakpoint
CREATE INDEX "room_messages_company_idx" ON "room_messages" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "room_messages_action_status_idx" ON "room_messages" USING btree ("company_id","action_status");--> statement-breakpoint
CREATE INDEX "room_issues_issue_idx" ON "room_issues" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "room_issues_company_idx" ON "room_issues" USING btree ("company_id");
