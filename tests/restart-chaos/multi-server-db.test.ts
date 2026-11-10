import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../packages/db/src/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../packages/db/src/test-embedded-postgres.js";
import { checkCrossServer, readCrossServerEvidence, type ServerProcessWindow } from "./multi-server.js";

const support = await getEmbeddedPostgresTestSupport();
const COMPANY = "00000000-0000-4000-8000-000000000001";
const NOON = Date.parse("2026-11-10T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe.skipIf(!support.supported)("reading cross-server evidence from a wave database", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("chaos-ms-");
    db = createDb(temporary.connectionString, { maxConnections: 1 });
    // Only the columns the reader selects, with the product's names and types, in a schema ahead of the
    // migrated one (one connection, so the search path holds for every query).
    await db.$client.unsafe(`create schema chaos_ms`);
    await db.$client.unsafe(`set search_path to chaos_ms, public`);
    await db.$client.unsafe(`create table heartbeat_runs (id uuid primary key, company_id uuid not null, issue_id uuid, status text not null,
      error_code text, finished_at timestamptz, updated_at timestamptz not null, controller_boot_id uuid)`);
    await db.$client.unsafe(`create table native_run_finalizations (run_id uuid primary key, controller_boot_id text, lease_holder jsonb)`);
    await db.$client.unsafe(`create table controller_instances (boot_id text primary key, pid integer not null)`);
    await db.$client.unsafe(`create table heartbeat_run_events (run_id uuid not null, event_type text not null, payload jsonb, created_at timestamptz not null)`);
    await db.$client.unsafe(`insert into controller_instances values ('boot-a', 100), ('boot-b', 200)`);
    // #20508's marker: still running, with the ownership code, written by another server's sweep.
    await db.$client.unsafe(`insert into heartbeat_runs values ('00000000-0000-4000-8000-0000000000a1', $1, null, 'running',
      'native_execution_ownership_unverified', null, $2, null)`, [COMPANY, iso(NOON)]);
    await db.$client.unsafe(`insert into native_run_finalizations values ('00000000-0000-4000-8000-0000000000a1', 'boot-a', null)`);
    // An ordinary success: not read as a failure.
    await db.$client.unsafe(`insert into heartbeat_runs values ('00000000-0000-4000-8000-0000000000a2', $1, null, 'succeeded', null, $2, $2, null)`, [COMPANY, iso(NOON)]);
    await db.$client.unsafe(`insert into heartbeat_run_events values ('00000000-0000-4000-8000-0000000000a2', 'native.process_identity_recorded', '{"processPid": 11}', $1),
      ('00000000-0000-4000-8000-0000000000a2', 'native.process_identity_recorded', '{"processPid": 12}', $2)`, [iso(NOON - 2_000), iso(NOON - 1_000)]);
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  it("reads a running run that carries the ownership marker, at its write time, and charges it to a live owner", async () => {
    const evidence = await readCrossServerEvidence(db, COMPANY);
    expect(evidence.runs).toEqual([expect.objectContaining({ runId: "00000000-0000-4000-8000-0000000000a1", status: "running",
      errorCode: "native_execution_ownership_unverified", endedAt: NOON, ownerBootId: "boot-a", ownerPid: 100 })]);
    expect(evidence.events.map(event => event.pid)).toEqual(expect.arrayContaining([11, 12]));
    const windows: ServerProcessWindow[] = [
      { pid: 100, role: "primary", spawnedAt: NOON - 60_000, exitedAt: null, frozen: [{ from: NOON - 50_000, to: NOON - 5_000 }] },
      { pid: 200, role: "secondary", spawnedAt: NOON - 55_000, exitedAt: null, frozen: [] },
    ];
    const check = checkCrossServer({ ...evidence, windows });
    expect(check.violations.map(violation => [violation.rule, violation.runId])).toEqual([
      ["MS_foreign_failure", "00000000-0000-4000-8000-0000000000a1"],
      ["MS_double_executor", "00000000-0000-4000-8000-0000000000a2"],
    ]);
  });
});
