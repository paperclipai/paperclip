CREATE TABLE "brand_kits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"design_md" text DEFAULT '' NOT NULL,
	"tokens" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brand_kits" ADD CONSTRAINT "brand_kits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brand_kits_company_idx" ON "brand_kits" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "brand_kits_company_slug_uq" ON "brand_kits" USING btree ("company_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "brand_kits_company_default_uq" ON "brand_kits" USING btree ("company_id") WHERE "is_default" = true;--> statement-breakpoint
CREATE TABLE "brand_kit_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_kit_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brand_kit_assets" ADD CONSTRAINT "brand_kit_assets_brand_kit_id_brand_kits_id_fk" FOREIGN KEY ("brand_kit_id") REFERENCES "public"."brand_kits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_kit_assets" ADD CONSTRAINT "brand_kit_assets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brand_kit_assets_kit_role_uq" ON "brand_kit_assets" USING btree ("brand_kit_id","role");--> statement-breakpoint
CREATE INDEX "brand_kit_assets_asset_idx" ON "brand_kit_assets" USING btree ("asset_id");--> statement-breakpoint
INSERT INTO "brand_kits" ("company_id", "name", "slug", "is_default", "design_md", "tokens")
SELECT
	c."id",
	'Default',
	'default',
	true,
	'',
	jsonb_strip_nulls(jsonb_build_object('name', c."name", 'colors',
		CASE WHEN c."brand_color" IS NOT NULL THEN jsonb_build_object('primary', c."brand_color") ELSE NULL END))
FROM "companies" c
WHERE NOT EXISTS (
	SELECT 1 FROM "brand_kits" bk WHERE bk."company_id" = c."id" AND bk."is_default" = true
);--> statement-breakpoint
INSERT INTO "brand_kit_assets" ("brand_kit_id", "asset_id", "role")
SELECT bk."id", cl."asset_id", 'logo_primary'
FROM "brand_kits" bk
JOIN "company_logos" cl ON cl."company_id" = bk."company_id"
WHERE bk."is_default" = true
ON CONFLICT DO NOTHING;
