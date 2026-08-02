UPDATE "agents"
SET
  "adapter_type" = 'jcode_local',
  "status" = CASE
    WHEN "status" = 'error' AND "error_reason" = 'Process adapter missing command' THEN 'idle'
    ELSE "status"
  END,
  "error_reason" = CASE
    WHEN "status" = 'error' AND "error_reason" = 'Process adapter missing command' THEN NULL
    ELSE "error_reason"
  END,
  "updated_at" = NOW()
WHERE "adapter_type" = 'jcode';
