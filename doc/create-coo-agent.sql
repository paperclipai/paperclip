-- Create COO agent (Alexander Drake) on the VPS database
-- Run this AFTER the company has been set up and Marcus Cole (CEO) has been created.
--
-- Find company ID:
--   SELECT id, name FROM companies;
-- Find CEO agent ID:
--   SELECT id, name FROM agents WHERE name = 'Marcus Cole';

DO $$
DECLARE
  v_company_id uuid;
  v_ceo_id uuid;
  v_coo_id uuid := gen_random_uuid();
BEGIN
  -- Resolve company and CEO IDs
  SELECT id INTO v_company_id FROM companies LIMIT 1;
  SELECT id INTO v_ceo_id FROM agents WHERE name = 'Marcus Cole' LIMIT 1;

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company found. Set up the company first.';
  END IF;

  IF v_ceo_id IS NULL THEN
    RAISE EXCEPTION 'Marcus Cole (CEO) not found. Create the CEO agent first.';
  END IF;

  INSERT INTO agents (
    id,
    company_id,
    name,
    role,
    title,
    department,
    adapter_type,
    adapter_config,
    runtime_config,
    status,
    reports_to,
    icon,
    employment_type,
    created_at,
    updated_at
  ) VALUES (
    v_coo_id,
    v_company_id,
    'Alexander Drake',
    'coo',                       -- role enum: coo = Chief Operating Officer
    'Alexander Drake - COO',
    'operations',
    'ollama_cloud',
    '{"model": "deepseek-v3.2:cloud"}'::jsonb,
    '{"heartbeat": {"enabled": true, "intervalSec": 3600, "wakeOnDemand": true, "cooldownSec": 10, "maxConcurrentRuns": 1}}'::jsonb,
    'idle',
    v_ceo_id,
    'gauge',
    'full_time',
    now(),
    now()
  );

  RAISE NOTICE 'Created Alexander Drake (COO) with ID: %', v_coo_id;
  RAISE NOTICE 'Company ID: %', v_company_id;
  RAISE NOTICE 'Reports to (Marcus Cole): %', v_ceo_id;
END $$;
