DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "account"
    GROUP BY "provider_id", "account_id"
    HAVING COUNT(DISTINCT "user_id") > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce OIDC account uniqueness: one provider account is linked to multiple users';
  END IF;

  DELETE FROM "account" duplicate
  USING "account" keeper
  WHERE duplicate."provider_id" = keeper."provider_id"
    AND duplicate."account_id" = keeper."account_id"
    AND duplicate."user_id" = keeper."user_id"
    AND duplicate."id" > keeper."id";
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_provider_account_unique" ON "account" USING btree ("provider_id", "account_id");
