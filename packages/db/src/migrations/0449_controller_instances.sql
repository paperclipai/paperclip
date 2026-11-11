CREATE TABLE "controller_instances" (
	"boot_id" text PRIMARY KEY NOT NULL,
	"epoch" bigserial NOT NULL,
	"process_space" text NOT NULL,
	"pid" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"renewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"fenced_at" timestamp with time zone,
	"fenced_by_epoch" bigint,
	"stopped_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "controller_instances_epoch_idx" ON "controller_instances" USING btree ("epoch");--> statement-breakpoint
CREATE INDEX "controller_instances_lease_idx" ON "controller_instances" USING btree ("lease_expires_at");