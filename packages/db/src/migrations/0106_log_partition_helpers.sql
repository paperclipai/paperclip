-- Partition helpers for high-volume log tables.
--
-- This migration is purely additive: it installs SQL helper functions that
-- create monthly range partitions on demand and drop expired partitions in
-- bulk. It does NOT convert existing tables to partitioned tables — that is
-- a one-off operator step shipped as `server/scripts/partition-log-tables.sql`
-- because it copies data and briefly takes an ACCESS EXCLUSIVE lock.
--
-- Once an operator runs the cutover script, the runtime retention sweeper
-- (server/src/services/log-table-retention.ts) automatically prefers
-- DROP PARTITION over batched DELETE, eliminating the autovacuum bloat that
-- the activity_log / heartbeat_run_events / agent_wakeup_requests tables
-- accumulate under heavy write load (BTCAAAAA-37815).

CREATE OR REPLACE FUNCTION paperclip_log_partition_name(
  p_table text,
  p_month_start date
) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT format('%s_y%sm%s',
    p_table,
    to_char(p_month_start, 'YYYY'),
    to_char(p_month_start, 'MM'));
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION paperclip_is_table_partitioned(p_table text)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_partitioned_table pt
    JOIN pg_class c ON c.oid = pt.partrelid
    WHERE c.relname = p_table
  );
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION paperclip_ensure_log_partition(
  p_table text,
  p_month_start date
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_child text;
  v_start date := date_trunc('month', p_month_start)::date;
  v_end   date := (date_trunc('month', p_month_start) + interval '1 month')::date;
BEGIN
  IF NOT paperclip_is_table_partitioned(p_table) THEN
    RETURN NULL;
  END IF;

  v_child := paperclip_log_partition_name(p_table, v_start);

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
    v_child, p_table, v_start, v_end
  );

  RETURN v_child;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION paperclip_ensure_log_partitions_window(
  p_table text,
  p_months_back int DEFAULT 0,
  p_months_ahead int DEFAULT 2
) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  v_month date;
  v_created int := 0;
  v_name text;
BEGIN
  IF NOT paperclip_is_table_partitioned(p_table) THEN
    RETURN 0;
  END IF;

  FOR v_month IN
    SELECT generate_series(
      date_trunc('month', now()) - (p_months_back || ' months')::interval,
      date_trunc('month', now()) + (p_months_ahead || ' months')::interval,
      interval '1 month'
    )::date
  LOOP
    v_name := paperclip_ensure_log_partition(p_table, v_month);
    IF v_name IS NOT NULL THEN
      v_created := v_created + 1;
    END IF;
  END LOOP;

  RETURN v_created;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION paperclip_drop_old_log_partitions(
  p_table text,
  p_cutoff timestamptz
) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  v_child record;
  v_dropped int := 0;
  v_bound_upper timestamptz;
  v_upper_text text;
BEGIN
  IF NOT paperclip_is_table_partitioned(p_table) THEN
    RETURN 0;
  END IF;

  FOR v_child IN
    SELECT
      c.oid::regclass AS child_regclass,
      c.relname AS child_name,
      pg_get_expr(c.relpartbound, c.oid) AS bound_expr
    FROM pg_inherits i
    JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE parent.relname = p_table
  LOOP
    v_upper_text := substring(v_child.bound_expr FROM 'TO \(''([^'']+)''\)');
    IF v_upper_text IS NULL THEN
      CONTINUE;
    END IF;

    BEGIN
      v_bound_upper := v_upper_text::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;
    END;

    IF v_bound_upper <= p_cutoff THEN
      EXECUTE format('DROP TABLE %s', v_child.child_regclass);
      v_dropped := v_dropped + 1;
    END IF;
  END LOOP;

  RETURN v_dropped;
END;
$$;
