CREATE TABLE "company_roles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "key" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "is_system" boolean NOT NULL DEFAULT false,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "company_roles_company_key_uq" ON "company_roles" ("company_id", "key");
--> statement-breakpoint
CREATE UNIQUE INDEX "company_roles_company_name_uq" ON "company_roles" ("company_id", "name");
--> statement-breakpoint
CREATE INDEX "company_roles_company_status_idx" ON "company_roles" ("company_id", "status");
--> statement-breakpoint

CREATE TABLE "company_role_permissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "role_id" uuid NOT NULL REFERENCES "company_roles"("id") ON DELETE cascade,
  "permission_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "company_role_permissions_role_permission_uq"
  ON "company_role_permissions" ("role_id", "permission_key");
--> statement-breakpoint
CREATE INDEX "company_role_permissions_permission_idx"
  ON "company_role_permissions" ("permission_key");
--> statement-breakpoint

CREATE TABLE "principal_role_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "role_id" uuid NOT NULL REFERENCES "company_roles"("id") ON DELETE cascade,
  "principal_type" text NOT NULL,
  "principal_id" text NOT NULL,
  "scope" jsonb,
  "assigned_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "principal_role_assignments_company_role_principal_uq"
  ON "principal_role_assignments" ("company_id", "role_id", "principal_type", "principal_id");
--> statement-breakpoint
CREATE INDEX "principal_role_assignments_company_principal_idx"
  ON "principal_role_assignments" ("company_id", "principal_type", "principal_id");
--> statement-breakpoint
CREATE INDEX "principal_role_assignments_company_role_idx"
  ON "principal_role_assignments" ("company_id", "role_id");
