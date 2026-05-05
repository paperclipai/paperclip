-- Migration: rt2_work_board_power_up_parity_2
-- Adding formula expression to custom fields, WIP limits per lane, and card templates

-- 1. Add formula_expression column to existing rt2_work_board_custom_fields table
ALTER TABLE rt2_work_board_custom_fields ADD COLUMN formula_expression TEXT;

-- 2. Create lane settings table for WIP limits
CREATE TABLE rt2_work_board_lane_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id ON DELETE CASCADE),
  project_id UUID NOT NULL REFERENCES projects(id ON DELETE CASCADE),
  lane TEXT NOT NULL,
  wip_limit INTEGER,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT rt2_work_board_lane_settings_company_project_lane_uq UNIQUE (company_id, project_id, lane)
);

CREATE INDEX rt2_work_board_lane_settings_company_project_idx ON rt2_work_board_lane_settings(company_id, project_id);

-- 3. Create card templates table
CREATE TABLE rt2_work_board_card_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id ON DELETE CASCADE),
  project_id UUID NOT NULL REFERENCES projects(id ON DELETE CASCADE),
  name TEXT NOT NULL,
  description TEXT,
  due_date_offset INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  created_by_user_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX rt2_work_board_card_templates_company_project_idx ON rt2_work_board_card_templates(company_id, project_id);

-- 4. Create card template field values table
CREATE TABLE rt2_work_board_card_template_field_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id ON DELETE CASCADE),
  template_id UUID NOT NULL REFERENCES rt2_work_board_card_templates(id ON DELETE CASCADE),
  field_id UUID NOT NULL REFERENCES rt2_work_board_custom_fields(id ON DELETE CASCADE),
  text_value TEXT,
  number_value REAL,
  date_value TIMESTAMP WITH TIME ZONE,
  option_id UUID REFERENCES rt2_work_board_custom_field_options(id ON DELETE SET NULL),
  CONSTRAINT rt2_work_board_card_template_field_values_template_field_uq UNIQUE (template_id, field_id)
);