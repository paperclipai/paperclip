-- Estate Management Core Entities: estates, beneficiaries, trusts, trust_assets, collaborators
-- IUN-1568 deliverables

CREATE TYPE "estate_type" AS ENUM ('individual', 'joint', 'trust', 'estate');
CREATE TYPE "marital_status" AS ENUM ('single', 'married', 'divorced', 'widowed', 'domestic_partnership');
CREATE TYPE "designation_type" AS ENUM ('primary', 'contingent', 'per_stirpes');
CREATE TYPE "trust_type" AS ENUM ('revocable', 'irrevocable', 'testamentary', 'special_needs');
CREATE TYPE "trust_funding_status" AS ENUM ('unfunded', 'partially_funded', 'fully_funded');
CREATE TYPE "collaborator_access_level" AS ENUM ('read', 'read_write');

-- Core estate entity (owner's estate record)
CREATE TABLE IF NOT EXISTS "estates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "owner_user_id" text NOT NULL,
  "name" text NOT NULL,
  "estate_type" "estate_type" NOT NULL DEFAULT 'individual',
  "marital_status" "marital_status",
  "state_of_residence" text,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "estates_company_owner_idx" ON "estates" ("company_id", "owner_user_id");

-- Beneficiaries linked to an estate
CREATE TABLE IF NOT EXISTS "estate_beneficiaries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "estate_id" uuid NOT NULL REFERENCES "estates"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "name" text NOT NULL,
  "relationship" text,
  "email" text,
  "phone" text,
  "allocation_percentage" numeric(5, 2),
  "designation_type" "designation_type" NOT NULL DEFAULT 'primary',
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "estate_beneficiaries_estate_idx" ON "estate_beneficiaries" ("estate_id");

-- Trusts linked to an estate
CREATE TABLE IF NOT EXISTS "estate_trusts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "estate_id" uuid NOT NULL REFERENCES "estates"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "trust_name" text NOT NULL,
  "trust_type" "trust_type" NOT NULL,
  "trustee_user_id" text,
  "successor_trustee_name" text,
  "funding_status" "trust_funding_status" NOT NULL DEFAULT 'unfunded',
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "estate_trusts_estate_idx" ON "estate_trusts" ("estate_id");

-- Trust-asset many-to-many linkage
CREATE TABLE IF NOT EXISTS "estate_trust_assets" (
  "trust_id" uuid NOT NULL REFERENCES "estate_trusts"("id") ON DELETE CASCADE,
  "asset_id" uuid NOT NULL REFERENCES "estate_assets"("id") ON DELETE CASCADE,
  "transfer_date" timestamp with time zone,
  "transfer_deed_doc_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("trust_id", "asset_id")
);

-- Collaborators (advisors with access to an estate)
CREATE TABLE IF NOT EXISTS "estate_collaborators" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "estate_id" uuid NOT NULL REFERENCES "estates"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "advisor_user_id" text,
  "invited_by_user_id" text NOT NULL,
  "email" text NOT NULL,
  "access_level" "collaborator_access_level" NOT NULL DEFAULT 'read',
  "invite_token" text NOT NULL,
  "accepted_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "estate_collaborators_estate_idx" ON "estate_collaborators" ("estate_id");
CREATE UNIQUE INDEX "estate_collaborators_token_idx" ON "estate_collaborators" ("invite_token");

-- Add optional estate_id FK to existing estate_assets for estate-centric linking
ALTER TABLE "estate_assets" ADD COLUMN IF NOT EXISTS "estate_id" uuid REFERENCES "estates"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "estate_assets_estate_idx" ON "estate_assets" ("estate_id");
