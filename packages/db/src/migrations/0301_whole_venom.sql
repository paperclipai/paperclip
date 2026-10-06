CREATE TABLE "plugin_lifecycle_acknowledgments" (
	"plugin_id" uuid NOT NULL,
	"event_id" bigint NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_lifecycle_acknowledgments_plugin_id_event_id_pk" PRIMARY KEY("plugin_id","event_id")
);
--> statement-breakpoint
ALTER TABLE "plugin_lifecycle_acknowledgments" ADD CONSTRAINT "plugin_lifecycle_acknowledgments_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_lifecycle_acknowledgments" ADD CONSTRAINT "plugin_lifecycle_acknowledgments_event_id_resource_lifecycle_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."resource_lifecycle_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plugin_lifecycle_acknowledgments_event_idx" ON "plugin_lifecycle_acknowledgments" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "resource_lifecycle_events_resource_order_idx" ON "resource_lifecycle_events" USING btree ("company_id","resource_type","resource_id","id");