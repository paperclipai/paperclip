-- restore-verify.sql — prove a restored Paperclip database is actually usable.
--
-- Run this against a database you have just restored, BEFORE you point the
-- server at it. It checks the invariants a restore can silently break, prints a
-- board inventory to compare against your pre-incident numbers, and raises an
-- exception (psql exit 3 under ON_ERROR_STOP) if any check failed — so it is
-- safe to use as a gate in a script.
--
-- Usage (deployment box, database in the compose stack):
--   docker compose -f compose.yaml exec -T db \
--     psql -U paperclip -d paperclip -v ON_ERROR_STOP=1 -f - < scripts/restore-verify.sql
--
-- Usage (any reachable database):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/restore-verify.sql
--
-- It is read-only apart from one temporary table, and it never writes to the
-- board's own tables.
--
-- What it deliberately does NOT do: compare row counts against the source. A
-- restore target has no way to know what the source held, so counts are printed
-- for a human to compare, not asserted. See docs/deploy/backup-restore.md.

\set ON_ERROR_STOP on

create temporary table restore_verify_results (
  ord      int,
  check_name text,
  status   text,
  detail   text
);

-- 1. The core board relations exist at all. A dump that was truncated mid
--    stream, or loaded into the wrong database, fails here first.
insert into restore_verify_results
select
  1,
  'core relations present',
  case when count(*) filter (where reg is null) = 0 then 'PASS' else 'FAIL' end,
  case
    when count(*) filter (where reg is null) = 0
      then format('all %s core relations present', count(*))
    else 'missing: ' || string_agg(name, ', ') filter (where reg is null)
  end
from (
  select name, to_regclass(name) as reg
  from unnest(array[
    'public.companies',
    'public.agents',
    'public.projects',
    'public.issues',
    'public.issue_comments',
    'public.heartbeat_runs',
    'public.heartbeat_run_events'
  ]) as t(name)
) s;

-- 2. The migration journal came back. Without it the server cannot tell which
--    migrations have run and will try to re-apply the whole history.
insert into restore_verify_results
select
  2,
  'migration journal present',
  case when to_regclass('drizzle.__drizzle_migrations') is null then 'FAIL'
       else case when (select count(*) from drizzle.__drizzle_migrations) > 0
                 then 'PASS' else 'FAIL' end
  end,
  case when to_regclass('drizzle.__drizzle_migrations') is null
       then 'drizzle.__drizzle_migrations is missing — the dump omitted the drizzle schema'
       else format('%s migration(s) recorded, newest hash %s',
                   (select count(*) from drizzle.__drizzle_migrations),
                   (select left(hash, 16) from drizzle.__drizzle_migrations
                     order by created_at desc limit 1))
  end;

-- 3. Extensions the schema depends on. pg_dump emits CREATE EXTENSION, but it
--    is skipped without the privilege to create it, and the failure only
--    surfaces later as a missing-operator error at query time.
insert into restore_verify_results
select
  3,
  'required extensions installed',
  case when count(*) = 2 then 'PASS' else 'FAIL' end,
  case when count(*) = 2 then 'pg_trgm, fuzzystrmatch'
       else 'missing: ' || coalesce((
         select string_agg(w, ', ')
         from unnest(array['pg_trgm', 'fuzzystrmatch']) as u(w)
         where w not in (select extname from pg_extension)
       ), 'none') end
from pg_extension
where extname in ('pg_trgm', 'fuzzystrmatch');

-- 4. Referential integrity across the board graph. A partial restore — one
--    table's COPY aborted, or a dump taken with per-table filters — shows up
--    here as orphans even though every statement "succeeded".
insert into restore_verify_results
select
  4,
  'referential integrity',
  case when sum(violations) = 0 then 'PASS' else 'FAIL' end,
  case when sum(violations) = 0
       then 'no orphaned rows across 6 relationships'
       else string_agg(format('%s: %s orphan(s)', label, violations), '; ')
              filter (where violations > 0)
  end
from (
  select 'issues -> companies' as label, count(*) as violations
    from issues i left join companies c on c.id = i.company_id
    where c.id is null
  union all
  select 'agents -> companies', count(*)
    from agents a left join companies c on c.id = a.company_id
    where c.id is null
  union all
  select 'projects -> companies', count(*)
    from projects p left join companies c on c.id = p.company_id
    where c.id is null
  union all
  select 'issue_comments -> issues', count(*)
    from issue_comments ic left join issues i on i.id = ic.issue_id
    where i.id is null
  union all
  select 'heartbeat_runs -> agents', count(*)
    from heartbeat_runs r left join agents a on a.id = r.agent_id
    where r.agent_id is not null and a.id is null
  union all
  select 'heartbeat_run_events -> heartbeat_runs', count(*)
    from heartbeat_run_events e left join heartbeat_runs r on r.id = e.run_id
    where r.id is null
) s;

-- 5. The board is not empty. The most embarrassing restore outcome is a
--    structurally perfect database with no data in it, which every other check
--    above passes cleanly.
insert into restore_verify_results
select
  5,
  'board is populated',
  case when (select count(*) from companies) > 0
        and (select count(*) from agents) > 0
       then 'PASS' else 'FAIL' end,
  format('%s company/companies, %s agent(s)',
         (select count(*) from companies),
         (select count(*) from agents));

-- 6. Sequences are ahead of the data they hand out ids for. pg_dump restores
--    sequence values via setval, but a dump assembled another way — or a
--    partial reload — leaves a sequence behind its column's max, and the
--    symptom is a duplicate-key error on the first insert after go-live, not
--    at restore time.
do $$
declare
  rec record;
  seq_last bigint;
  col_max  bigint;
  behind   text[] := array[]::text[];
  checked  int := 0;
begin
  for rec in
    select
      seqns.nspname  as seq_schema,
      seq.relname    as seq_name,
      tblns.nspname  as tbl_schema,
      tbl.relname    as tbl_name,
      att.attname    as col_name
    from pg_class seq
    join pg_namespace seqns on seqns.oid = seq.relnamespace
    join pg_depend dep
      on dep.objid = seq.oid
     and dep.classid = 'pg_class'::regclass
     and dep.deptype in ('a', 'i')
    join pg_class tbl on tbl.oid = dep.refobjid
    join pg_namespace tblns on tblns.oid = tbl.relnamespace
    join pg_attribute att
      on att.attrelid = tbl.oid
     and att.attnum = dep.refobjsubid
    where seq.relkind = 'S'
      and tbl.relkind = 'r'
      and seqns.nspname not like 'pg_%'
  loop
    checked := checked + 1;
    execute format('select last_value from %I.%I', rec.seq_schema, rec.seq_name)
      into seq_last;
    execute format('select coalesce(max(%I), 0) from %I.%I',
                   rec.col_name, rec.tbl_schema, rec.tbl_name)
      into col_max;
    if seq_last < col_max then
      behind := behind || format('%s.%s at %s but max(%s.%s)=%s',
                                 rec.seq_schema, rec.seq_name, seq_last,
                                 rec.tbl_name, rec.col_name, col_max);
    end if;
  end loop;

  insert into restore_verify_results
  values (
    6,
    'sequences ahead of their data',
    case when array_length(behind, 1) is null then 'PASS' else 'FAIL' end,
    case when array_length(behind, 1) is null
         then format('%s sequence(s) checked, all ahead of their column max', checked)
         else array_to_string(behind, '; ')
    end
  );
end $$;

\echo ''
\echo '=== restore verification ==='
select check_name as "check", status, detail
from restore_verify_results
order by ord;

\echo ''
\echo '=== board inventory — compare these against your pre-incident numbers ==='
select 'companies' as entity, count(*) as rows from companies
union all select 'agents', count(*) from agents
union all select 'projects', count(*) from projects
union all select 'issues', count(*) from issues
union all select 'issue_comments', count(*) from issue_comments
union all select 'heartbeat_runs', count(*) from heartbeat_runs
union all select 'heartbeat_run_events', count(*) from heartbeat_run_events
order by entity;

\echo ''
\echo '=== run history reach — the newest run per agent that has any ==='
select a.name as agent, count(r.id) as runs, max(r.created_at) as newest_run
from agents a
join heartbeat_runs r on r.agent_id = a.id
group by a.name
order by runs desc
limit 10;

\echo ''
\echo '=== run logs live OUTSIDE the database — these need the volume artifact ==='
select
  coalesce(log_store, '(none)') as log_store,
  count(*) as runs,
  count(log_ref) as with_ref
from heartbeat_runs
group by log_store
order by runs desc;

-- Fail the process if anything above failed, so a caller can gate on exit code.
do $$
declare
  failures text;
begin
  select string_agg(check_name, ', ')
    into failures
    from restore_verify_results
   where status = 'FAIL';

  if failures is not null then
    raise exception 'restore verification FAILED: %', failures
      using hint = 'See the check table above. Do not point the server at this database.';
  end if;
end $$;

\echo ''
\echo 'RESTORE VERIFICATION PASSED'
