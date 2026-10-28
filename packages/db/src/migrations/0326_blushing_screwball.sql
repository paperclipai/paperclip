CREATE TABLE IF NOT EXISTS "chat_voice_callbacks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"phone_number" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_voice_callbacks_phone_check" CHECK ("chat_voice_callbacks"."phone_number" ~ '^\+[1-9][0-9]{6,14}$')
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_voice_callbacks_endpoint_fk' AND conrelid = 'chat_voice_callbacks'::regclass) THEN
    ALTER TABLE "chat_voice_callbacks" ADD CONSTRAINT "chat_voice_callbacks_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_voice_callbacks_owner_uq" ON "chat_voice_callbacks" USING btree ("company_id","endpoint_id","user_id");