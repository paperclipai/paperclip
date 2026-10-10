CREATE TABLE "resource_lifecycle_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "resource_lifecycle_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_lifecycle_events_resource_type_check" CHECK ("resource_lifecycle_events"."resource_type" IN ('agent', 'project')),
	CONSTRAINT "resource_lifecycle_events_action_check" CHECK ("resource_lifecycle_events"."action" = 'create' OR ("resource_lifecycle_events"."resource_type" = 'agent' AND "resource_lifecycle_events"."action" IN ('pause', 'resume', 'terminate')))
);
--> statement-breakpoint
ALTER TABLE "resource_lifecycle_events" ADD CONSTRAINT "resource_lifecycle_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_lifecycle_events_creation_idx" ON "resource_lifecycle_events" USING btree ("company_id","resource_type","resource_id") WHERE "resource_lifecycle_events"."action" = 'create';--> statement-breakpoint
CREATE INDEX "resource_lifecycle_events_company_idx" ON "resource_lifecycle_events" USING btree ("company_id","id");