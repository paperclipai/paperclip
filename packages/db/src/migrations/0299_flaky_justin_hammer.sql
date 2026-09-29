CREATE TABLE "heartbeat_run_event_epochs" (
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"epoch" text NOT NULL,
	"next_epoch" uuid NOT NULL,
	"final_seq" bigint NOT NULL,
	CONSTRAINT "heartbeat_run_event_epochs_run_id_epoch_pk" PRIMARY KEY("run_id","epoch")
);
--> statement-breakpoint
CREATE TABLE "heartbeat_run_event_heads" (
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"lane" text NOT NULL,
	"event_id" text NOT NULL,
	CONSTRAINT "heartbeat_run_event_heads_run_id_lane_pk" PRIMARY KEY("run_id","lane")
);
--> statement-breakpoint
CREATE TABLE "heartbeat_run_event_links" (
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"lane" text NOT NULL,
	"event_id" text NOT NULL,
	"previous_id" text,
	CONSTRAINT "heartbeat_run_event_links_run_id_lane_event_id_pk" PRIMARY KEY("run_id","lane","event_id")
);
--> statement-breakpoint
DROP INDEX "heartbeat_run_events_run_seq_uq";--> statement-breakpoint
ALTER TABLE "native_output_body_chunks" DROP CONSTRAINT "native_output_body_chunks_event_id_heartbeat_run_events_id_fk";--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ALTER COLUMN "id" SET DATA TYPE text USING id::text;--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::text;--> statement-breakpoint
ALTER TABLE "native_output_body_chunks" ALTER COLUMN "event_id" SET DATA TYPE text USING event_id::text;--> statement-breakpoint
ALTER TABLE "native_output_body_chunks" ADD CONSTRAINT "native_output_body_chunks_event_id_heartbeat_run_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "heartbeat_run_events"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ADD COLUMN "event_epoch" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "event_epoch" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_run_event_epochs" ADD CONSTRAINT "heartbeat_run_event_epochs_company_id_run_id_heartbeat_runs_company_id_id_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."heartbeat_runs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_event_heads" ADD CONSTRAINT "heartbeat_run_event_heads_event_id_heartbeat_run_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."heartbeat_run_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_event_heads" ADD CONSTRAINT "heartbeat_run_event_heads_company_id_run_id_heartbeat_runs_company_id_id_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."heartbeat_runs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_event_links" ADD CONSTRAINT "heartbeat_run_event_links_event_id_heartbeat_run_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."heartbeat_run_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_event_links" ADD CONSTRAINT "heartbeat_run_event_links_company_id_run_id_heartbeat_runs_company_id_id_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."heartbeat_runs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_run_event_epochs_successor_uq" ON "heartbeat_run_event_epochs" USING btree ("run_id","next_epoch");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: The serial-to-opaque identity migration and epoch-key replacement run atomically under the migrator transaction; schedule a maintenance window for its one-time history-sized index/backfill cost. CONCURRENTLY is not legal inside this transaction.
CREATE UNIQUE INDEX "heartbeat_run_events_run_seq_uq" ON "heartbeat_run_events" USING btree ("run_id","event_epoch","seq");
--> statement-breakpoint
-- Fixed-size semantic lane names. SHA-256 is built into PostgreSQL; no extension.
CREATE FUNCTION paperclip_run_event_lanes(kind text, body jsonb, source_id text, message text, source_instance text)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $fn$
  SELECT array_remove(ARRAY[
    'all',
    'type:' || encode(sha256(convert_to(kind, 'UTF8')), 'hex'),
    CASE WHEN kind IN ('native.process_start_requested', 'native.process_identity_recorded', 'native.local_process_stopped') AND source_id IS NULL THEN 'native-process' END,
    CASE WHEN kind IN ('workspace.change.updated', 'workspace.diff.recorded') THEN 'workspace-diff' END,
    CASE WHEN kind IN ('run.result.proposed', 'run.terminal') AND source_instance IS NOT NULL
      THEN 'settlement:' || encode(sha256(convert_to(octet_length(source_instance)::text || ':' || source_instance || ':' || coalesce(body #>> '{prpEvent,turnId}', ''), 'UTF8')), 'hex') END,
    CASE WHEN kind IN ('session.started', 'session.resumed', 'session.reconciled') AND source_instance IS NOT NULL
      THEN 'provider-session:' || encode(sha256(convert_to(source_instance, 'UTF8')), 'hex') END,
    CASE WHEN kind IN ('workspace.ready', 'research.started', 'research.progressed', 'research.completed', 'tool.execution.started', 'tool.execution.progressed', 'tool.execution.completed', 'item.completed', 'delegation.started', 'delegation.updated', 'delegation.completed', 'workspace.change.updated', 'workspace.diff.recorded', 'workspace.file.referenced', 'artifact.generated') THEN 'safe-native-progress' END,
    CASE WHEN kind IN ('runtime_request.created', 'runtime_request.resolved', 'runtime_request.cancelled', 'runtime_request.expired') AND coalesce(body #>> '{prpEvent,payload,request,requestId}', body #>> '{prpEvent,payload,requestId}', '') <> ''
      THEN 'request:' || encode(sha256(convert_to(coalesce(body #>> '{prpEvent,payload,request,requestId}', body #>> '{prpEvent,payload,requestId}'), 'UTF8')), 'hex') END,
    CASE WHEN kind = 'item.completed' OR (kind = 'lifecycle' AND body->>'retryReasonCode' = 'semantic_result_missing') THEN 'presentation' END,
    CASE WHEN kind = 'lifecycle' AND message LIKE 'Bounded retry exhausted%' THEN 'exhaustion' END,
    CASE WHEN kind = 'lifecycle' AND message LIKE 'Bounded retry exhausted%'
      AND jsonb_typeof(body->'retryReason') = 'string' AND jsonb_typeof(body->'scheduledRetryAttempt') = 'number' AND jsonb_typeof(body->'maxAttempts') = 'number'
      THEN 'exhaustion-receipt:' || encode(sha256(convert_to(octet_length(body->>'retryReason')::text || ':' || (body->>'retryReason') || ':' || (body->>'scheduledRetryAttempt') || ':' || (body->>'maxAttempts'), 'UTF8')), 'hex') END,
    CASE WHEN kind IN ('harness.ready', 'session.started', 'session.resumed', 'session.updated', 'turn.started', 'provider.event', 'provider.rpc_result') THEN 'provider-identity' END
  ], NULL)
$fn$;
--> statement-breakpoint
-- Historical migration is deliberately O(history), under the migration lock.
-- New appends maintain these indexes in the same transaction as their event.
INSERT INTO heartbeat_run_event_links (company_id, run_id, lane, event_id, previous_id)
SELECT company_id, run_id, lane, id,
       lag(id) OVER (PARTITION BY run_id, lane ORDER BY seq)
FROM heartbeat_run_events
CROSS JOIN LATERAL unnest(paperclip_run_event_lanes(event_type, payload, source_event_id, message, source_instance_id)) AS lanes(lane);
--> statement-breakpoint
INSERT INTO heartbeat_run_event_heads (company_id, run_id, lane, event_id)
SELECT DISTINCT ON (e.run_id, link.lane) e.company_id, e.run_id, link.lane, e.id
FROM heartbeat_run_events e
JOIN heartbeat_run_event_links link ON link.run_id = e.run_id AND link.event_id = e.id
ORDER BY e.run_id, link.lane, e.seq DESC;
--> statement-breakpoint
CREATE FUNCTION paperclip_index_run_event() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE lane_key text; prior_id text; owner_company uuid; owner_agent uuid; owner_epoch text;
BEGIN
  SELECT company_id, agent_id, event_epoch INTO owner_company, owner_agent, owner_epoch
    FROM heartbeat_runs WHERE id = NEW.run_id FOR UPDATE;
  IF owner_company IS DISTINCT FROM NEW.company_id OR owner_agent IS DISTINCT FROM NEW.agent_id OR owner_epoch IS DISTINCT FROM NEW.event_epoch THEN
    RAISE EXCEPTION 'heartbeat_run_event_binding_mismatch';
  END IF;
  FOREACH lane_key IN ARRAY paperclip_run_event_lanes(NEW.event_type, NEW.payload, NEW.source_event_id, NEW.message, NEW.source_instance_id) LOOP
    SELECT event_id INTO prior_id FROM heartbeat_run_event_heads WHERE run_id = NEW.run_id AND lane = lane_key;
    INSERT INTO heartbeat_run_event_links (company_id, run_id, lane, event_id, previous_id)
      VALUES (NEW.company_id, NEW.run_id, lane_key, NEW.id, prior_id);
    INSERT INTO heartbeat_run_event_heads (company_id, run_id, lane, event_id)
      VALUES (NEW.company_id, NEW.run_id, lane_key, NEW.id)
      ON CONFLICT (run_id, lane) DO UPDATE SET event_id = EXCLUDED.event_id;
  END LOOP;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER paperclip_run_event_index AFTER INSERT ON heartbeat_run_events
FOR EACH ROW EXECUTE FUNCTION paperclip_index_run_event();
