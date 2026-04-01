DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cost_event_seat_attributions_seat_id_seats_id_fk') THEN
  ALTER TABLE "cost_event_seat_attributions" DROP CONSTRAINT "cost_event_seat_attributions_seat_id_seats_id_fk";
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cost_event_seat_attributions_seat_id_seats_id_fk') THEN
  ALTER TABLE "cost_event_seat_attributions" ADD CONSTRAINT "cost_event_seat_attributions_seat_id_seats_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."seats"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seat_occupancies_one_active_shadow_agent_per_seat_uq"
  ON "seat_occupancies" USING btree ("seat_id")
  WHERE "occupancy_role" = 'shadow_agent' AND "status" = 'active';
