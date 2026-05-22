-- FUL-2450: idempotent backfill to cancel stale active recovery actions
-- whose source issues are already terminal.
update issue_recovery_actions ira
set
  status = 'cancelled',
  outcome = 'cancelled',
  resolution_note = coalesce(
    ira.resolution_note,
    'Backfill cleanup: source issue already in terminal status.'
  ),
  resolved_at = coalesce(ira.resolved_at, now()),
  updated_at = now()
from issues i
where
  ira.source_issue_id = i.id
  and ira.company_id = i.company_id
  and ira.status in ('active', 'escalated')
  and i.status in ('done', 'cancelled');
