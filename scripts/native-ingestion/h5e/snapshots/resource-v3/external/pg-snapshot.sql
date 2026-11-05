-- PostgreSQL >=14. Read-only diagnostic; no query text, parameters or credentials.
-- pg_stat_database covers the whole database and includes this observer's work.
with
  scope as (select oid from pg_database where datname = current_database()),
  activity as (
    select a.pid, a.backend_start, a.backend_type, a.state,
      a.wait_event_type, a.wait_event, a.xact_start,
      pg_blocking_pids(a.pid) as blocking_pids
    from pg_stat_activity a
    where a.datid = (select oid from scope) and a.pid <> pg_backend_pid()
    order by a.pid limit 2049
  ),
  locks as (
    select l.pid, l.locktype, l.mode, l.granted, l.waitstart,
      l.database, l.relation, l.page, l.tuple
    from pg_locks l where l.pid in (select pid from activity)
    order by l.pid, l.locktype, l.mode limit 8193
  ),
  stats as (
    select datid, numbackends, xact_commit, xact_rollback,
      blks_read, blks_hit, tup_returned, tup_fetched, tup_inserted,
      tup_updated, tup_deleted, conflicts, temp_files, temp_bytes,
      deadlocks, blk_read_time, blk_write_time, stats_reset
    from pg_stat_database where datid = (select oid from scope)
  )
select json_build_object(
  'serverEpochMs', extract(epoch from clock_timestamp()) * 1000,
  'serverVersion', current_setting('server_version_num')::int,
  'databaseName', current_database(),
  'postmasterStartEpochMs', extract(epoch from pg_postmaster_start_time()) * 1000,
  'dataDirectory', current_setting('data_directory'),
  'configuredServerPort', current_setting('port')::int,
  'serverAddress', inet_server_addr()::text, 'clientAddress', inet_client_addr()::text,
  'serverPort', inet_server_port(), 'transactionReadOnly', current_setting('transaction_read_only'),
  'databaseOid', (select oid from scope), 'observerBackendPid', pg_backend_pid(),
  'activity', coalesce((select json_agg(activity) from activity), '[]'::json),
  'locks', coalesce((select json_agg(locks) from locks), '[]'::json),
  'databaseStats', (select row_to_json(stats) from stats),
  'activityCapExceeded', (select count(*) > 2048 from activity),
  'lockCapExceeded', (select count(*) > 8192 from locks)
) as snapshot;
