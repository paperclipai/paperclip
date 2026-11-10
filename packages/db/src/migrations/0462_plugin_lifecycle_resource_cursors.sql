CREATE TABLE "plugin_lifecycle_resource_cursors" (
	"plugin_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"acknowledged_through_id" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_lifecycle_resource_cursors_pk" PRIMARY KEY("plugin_id","company_id","resource_type","resource_id")
);
--> statement-breakpoint
ALTER TABLE "plugin_lifecycle_resource_cursors" ADD CONSTRAINT "plugin_lifecycle_resource_cursors_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_lifecycle_resource_cursors" ADD CONSTRAINT "plugin_lifecycle_resource_cursors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Carry acknowledgments forward. Each cursor ends at the contiguous acknowledged prefix of a
-- resource's events, so an unacknowledged gap or late creation is still delivered, and
-- acknowledged events after it are still skipped through their acknowledgment rows.
INSERT INTO "plugin_lifecycle_resource_cursors" ("plugin_id", "company_id", "resource_type", "resource_id", "acknowledged_through_id")
SELECT progress."plugin_id", progress."company_id", progress."resource_type", progress."resource_id",
  COALESCE((
    SELECT min(pending."id") - 1 FROM "resource_lifecycle_events" pending
    WHERE pending."company_id" = progress."company_id" AND pending."resource_type" = progress."resource_type"
      AND pending."resource_id" = progress."resource_id"
      AND NOT EXISTS (SELECT 1 FROM "plugin_lifecycle_acknowledgments" ack
        WHERE ack."plugin_id" = progress."plugin_id" AND ack."event_id" = pending."id")
  ), progress."last_acknowledged_id")
FROM (
  SELECT ack."plugin_id", acked_event."company_id", acked_event."resource_type", acked_event."resource_id", max(acked_event."id") AS "last_acknowledged_id"
  FROM "plugin_lifecycle_acknowledgments" ack
  JOIN "resource_lifecycle_events" acked_event ON acked_event."id" = ack."event_id"
  GROUP BY ack."plugin_id", acked_event."company_id", acked_event."resource_type", acked_event."resource_id"
) progress
ON CONFLICT DO NOTHING;
