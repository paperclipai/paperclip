CREATE TABLE "user_disablements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"reason" text,
	"disabled_by_user_id" text,
	"disabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enabled_by_user_id" text,
	"enabled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "user_disablements" ADD CONSTRAINT "user_disablements_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_disablements_active_user_uq" ON "user_disablements" USING btree ("user_id") WHERE "user_disablements"."enabled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "user_disablements_user_disabled_at_idx" ON "user_disablements" USING btree ("user_id","disabled_at");