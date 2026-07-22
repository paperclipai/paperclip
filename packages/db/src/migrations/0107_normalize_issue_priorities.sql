UPDATE "issues"
SET "priority" = CASE lower(trim("priority"))
  WHEN 'critical' THEN 'critical'
  WHEN 'high' THEN 'high'
  WHEN 'hoch' THEN 'high'
  WHEN 'medium' THEN 'medium'
  WHEN 'normal' THEN 'medium'
  WHEN 'low' THEN 'low'
  ELSE 'medium'
END
WHERE "priority" NOT IN ('critical', 'high', 'medium', 'low');
