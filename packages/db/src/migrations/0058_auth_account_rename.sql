DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'account'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'auth_account'
  ) THEN
    ALTER TABLE "account" RENAME TO "auth_account";
    ALTER TABLE "auth_account" RENAME CONSTRAINT "account_user_id_user_id_fk" TO "auth_account_user_id_user_id_fk";
  END IF;
END $$;
