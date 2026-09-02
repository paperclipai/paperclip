ALTER TABLE "environment_leases" DROP CONSTRAINT "environment_leases_environment_id_environments_id_fk";
--> statement-breakpoint
ALTER TABLE "environment_leases" ALTER COLUMN "environment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;