CREATE TABLE IF NOT EXISTS "principal_role_default_seeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"role" text NOT NULL,
	"settled_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'principal_role_default_seeds_company_id_companies_id_fk'
		  AND conrelid = 'principal_role_default_seeds'::regclass
	) THEN
		ALTER TABLE "principal_role_default_seeds"
			ADD CONSTRAINT "principal_role_default_seeds_company_id_companies_id_fk"
			FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
			ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "principal_role_default_seeds_unique_idx" ON "principal_role_default_seeds" USING btree ("company_id","principal_type","principal_id");
--> statement-breakpoint
-- Every human membership that is not archived is already past its bootstrap:
-- `backfillPrincipalAccessCompatibility` has swept it at every server start
-- since the seeder existed, so its role defaults have been applied and whatever
-- grant set it carries now is the answer. Marking them settled here is what
-- makes an existing revocation durable from this deploy rather than from the
-- next time each principal happens to be re-seeded.
--
-- Archived memberships are deliberately left unmarked. Removal deletes a
-- principal's grants, so an archived membership has none to protect, and a
-- marker would mean a re-added principal arrived with no permissions at all
-- instead of their role's defaults.
--
-- The CASE mirrors `normalizeHumanRole(value, "operator")`: 'member' and every
-- unrecognized or null role resolve to 'operator'.
INSERT INTO "principal_role_default_seeds" (
	"company_id",
	"principal_type",
	"principal_id",
	"role",
	"settled_by_user_id",
	"created_at",
	"updated_at"
)
SELECT
	"company_id",
	'user',
	"principal_id",
	CASE
		WHEN "membership_role" IN ('owner', 'admin', 'operator', 'viewer') THEN "membership_role"
		ELSE 'operator'
	END,
	NULL,
	now(),
	now()
FROM "company_memberships"
WHERE "principal_type" = 'user'
	AND "status" <> 'archived'
ON CONFLICT (
	"company_id",
	"principal_type",
	"principal_id"
) DO NOTHING;
