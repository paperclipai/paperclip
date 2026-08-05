-- Duplicate open fallback-monitor routine_execution rows that MUST cause
-- issues_open_fallback_monitor_execution_uq creation to fail (regression for
-- 2026-08-05 outage #3 / migration 0200 without precondition cleanup).
-- Disposable DB only.

INSERT INTO issues (id, company_id, title, status, origin_kind, hidden_at) VALUES
  ('11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'fallback-monitor',
   'todo',
   'routine_execution',
   NULL),
  ('22222222-2222-2222-2222-222222222222',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'Fallback-Monitor',
   'in_progress',
   'routine_execution',
   NULL);
