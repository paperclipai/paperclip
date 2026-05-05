-- Phase 90: Trello Automation / Power-up Parity (1)
-- Custom field schema: custom_fields, custom_field_options, card_custom_field_values

-- Migration 0115: Custom Field Tables
CREATE TABLE "rt2_work_board_custom_fields" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action,
  "name" text NOT NULL,
  "field_type" text NOT NULL DEFAULT 'text',
  "position" integer NOT NULL DEFAULT 0,
  "created_by_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "rt2_work_board_custom_fields_company_position_idx" ON "rt2_work_board_custom_fields" USING btree ("company_id","position");

CREATE TABLE "rt2_work_board_custom_field_options" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action,
  "field_id" uuid NOT NULL REFERENCES "public"."rt2_work_board_custom_fields"("id") ON DELETE cascade ON UPDATE no action,
  "label" text NOT NULL,
  "position" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "rt2_work_board_custom_field_options_field_position_idx" ON "rt2_work_board_custom_field_options" USING btree ("company_id","field_id","position");

CREATE TABLE "rt2_work_board_card_custom_field_values" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action,
  "issue_id" uuid NOT NULL REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action,
  "field_id" uuid NOT NULL REFERENCES "public"."rt2_work_board_custom_fields"("id") ON DELETE cascade ON UPDATE no action,
  "text_value" text,
  "number_value" real,
  "date_value" timestamp with time zone,
  "option_id" uuid REFERENCES "public"."rt2_work_board_custom_field_options"("id") ON DELETE set null ON UPDATE no action,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "rt2_work_board_card_cfv_issue_field_uq" ON "rt2_work_board_card_custom_field_values" USING btree ("company_id","issue_id","field_id");