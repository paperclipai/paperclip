import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

export async function createNativeRunLogTestTables(db: Db) {
  await db.execute(sql`create table heartbeat_runs(id uuid primary key, company_id uuid not null, agent_id uuid not null,
    status text not null, runtime_mode text not null default 'native', native_session_id text, runner_instance_id text,
    native_issue_id uuid, issue_id uuid, context_snapshot jsonb,
    log_store text, log_ref text, log_bytes bigint,
    log_sha256 text, last_output_seq bigint not null default 0, last_output_at timestamptz, last_output_stream text,
    last_output_bytes bigint, next_event_seq bigint not null default 1, controller_lease_expires_at timestamptz,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
  await db.execute(sql`create table heartbeat_run_events(id bigserial primary key, company_id uuid not null,
    run_id uuid not null, agent_id uuid not null, seq bigint not null, event_type text not null, stream text,
    level text, color text, message text, payload jsonb, source_instance_id text, source_event_id text,
    source_seq bigint, source_payload_sha256 text, protocol_schema_version int, created_at timestamptz not null default now(),
    unique(run_id,seq), unique(run_id,source_event_id), unique(run_id,source_instance_id,source_seq))`);
  await db.execute(
    sql`create table native_run_finalizations(run_id uuid, company_id uuid, lease_expires_at timestamptz)`,
  );
  await db.execute(sql`create table agent_identity_keys(agent_id uuid primary key,company_id uuid,algorithm text,key_id text,
    public_key_pem text,private_key_material jsonb,created_at timestamptz default now())`);
}
