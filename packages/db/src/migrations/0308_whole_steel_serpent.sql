CREATE TABLE IF NOT EXISTS "agent_identity_keys" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"algorithm" text NOT NULL,
	"key_id" text NOT NULL,
	"public_key_pem" text NOT NULL,
	"private_key_material" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_identity_keys_algorithm_check" CHECK ("agent_identity_keys"."algorithm" = 'Ed25519')
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.agent_identity_keys'::regclass
      AND conname = 'agent_identity_keys_owner_fk'
  ) THEN
    ALTER TABLE "agent_identity_keys" ADD CONSTRAINT "agent_identity_keys_owner_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
