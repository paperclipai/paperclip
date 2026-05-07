insert into principal_permission_grants (
  company_id,
  principal_type,
  principal_id,
  permission_key,
  scope,
  granted_by_user_id,
  created_at,
  updated_at
)
select
  cm.company_id,
  'agent',
  a.id::text,
  'skills:refresh',
  null,
  null,
  now(),
  now()
from agents a
join company_memberships cm
  on cm.company_id = a.company_id
 and cm.principal_type = 'agent'
 and cm.principal_id = a.id::text
 and cm.status = 'active'
where a.role in ('cto', 'engineer', 'qa', 'devops', 'ceo')
on conflict (company_id, principal_type, principal_id, permission_key) do nothing;
