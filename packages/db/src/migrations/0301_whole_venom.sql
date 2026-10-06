-- Lock resource writers before the journal foreign key and index take locks.
LOCK TABLE "agents", "projects" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
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
CREATE INDEX "resource_lifecycle_events_resource_order_idx" ON "resource_lifecycle_events" USING btree ("company_id","resource_type","resource_id","id");--> statement-breakpoint
-- Seed a one-time current-state baseline before plugins can consume the journal.
INSERT INTO "resource_lifecycle_events" ("company_id", "resource_type", "resource_id", "action")
SELECT "company_id", 'agent', "id", 'create'
FROM "agents"
WHERE "status" NOT IN ('pending_approval', 'terminated')
UNION ALL
SELECT "company_id", 'project', "id", 'create'
FROM "projects"
ON CONFLICT ("company_id", "resource_type", "resource_id") WHERE "action" = 'create' DO NOTHING;--> statement-breakpoint
-- Restore current stop/delete intent without repeating an existing final transition.
INSERT INTO "resource_lifecycle_events" ("company_id", "resource_type", "resource_id", "action")
SELECT a."company_id", 'agent', a."id", CASE a."status" WHEN 'paused' THEN 'pause' ELSE 'terminate' END
FROM "agents" a
WHERE a."status" IN ('paused', 'terminated')
  AND (SELECT e."action" FROM "resource_lifecycle_events" e
       WHERE e."company_id" = a."company_id" AND e."resource_type" = 'agent'
         AND e."resource_id" = a."id" AND e."action" <> 'create'
       ORDER BY e."id" DESC LIMIT 1)
      IS DISTINCT FROM CASE a."status" WHEN 'paused' THEN 'pause' ELSE 'terminate' END;--> statement-breakpoint
-- A partial journal may end at pause even though the current agent is running.
INSERT INTO "resource_lifecycle_events" ("company_id", "resource_type", "resource_id", "action")
SELECT a."company_id", 'agent', a."id", 'resume'
FROM "agents" a
WHERE a."status" NOT IN ('pending_approval', 'paused', 'terminated')
  AND (SELECT e."action" FROM "resource_lifecycle_events" e
       WHERE e."company_id" = a."company_id" AND e."resource_type" = 'agent'
         AND e."resource_id" = a."id" AND e."action" <> 'create'
       ORDER BY e."id" DESC LIMIT 1) = 'pause';
