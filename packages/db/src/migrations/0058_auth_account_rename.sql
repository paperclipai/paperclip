ALTER TABLE "account" RENAME TO "auth_account";
--> statement-breakpoint
ALTER TABLE "auth_account" RENAME CONSTRAINT "account_user_id_user_id_fk" TO "auth_account_user_id_user_id_fk";
