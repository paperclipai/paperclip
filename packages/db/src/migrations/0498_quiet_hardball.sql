CREATE TABLE "company_workload_identity_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key_id" text NOT NULL,
	"algorithm" text NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"private_key_material" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_workload_identity_keys_algorithm_check" CHECK ("company_workload_identity_keys"."algorithm" = 'ES256'),
	CONSTRAINT "company_workload_identity_keys_status_check" CHECK ("company_workload_identity_keys"."status" in ('next', 'active', 'retiring', 'retired'))
);
--> statement-breakpoint
ALTER TABLE "company_workload_identity_keys" ADD CONSTRAINT "company_workload_identity_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_workload_identity_keys_company_key_uq" ON "company_workload_identity_keys" USING btree ("company_id","key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_workload_identity_keys_one_active_uq" ON "company_workload_identity_keys" USING btree ("company_id") WHERE "company_workload_identity_keys"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "company_workload_identity_keys_one_next_uq" ON "company_workload_identity_keys" USING btree ("company_id") WHERE "company_workload_identity_keys"."status" = 'next';