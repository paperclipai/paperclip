import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../packages/db/src/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../packages/db/src/test-embedded-postgres.js";
import { ageWaveDatabase, unshiftJson } from "./time-faults.js";

const support = await getEmbeddedPostgresTestSupport();
const HOUR = 3_600_000;
const NOON = Date.parse("2026-11-09T12:00:00.123Z");
const ms = (value: unknown) => new Date(value as string).getTime();

describe.skipIf(!support.supported)("aging a wave database", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let evidenceDir: string;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("chaos-time-");
    db = createDb(temporary.connectionString, { maxConnections: 1 });
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "chaos-time-evidence-"));
    await db.$client.unsafe(`create table chaos_time_comments (id text primary key, updated_at timestamptz not null, body text not null)`);
    await db.$client.unsafe(`create table chaos_time_runs (id text primary key, status text, lease_expires_at timestamptz, finished_at timestamptz, context jsonb,
      controller_process_started_at timestamptz)`);
    await db.$client.unsafe(`create table chaos_time_touch (id text primary key, updated_at timestamptz)`);
    // A trigger that would rewrite updated_at on every update: the shift must not fire it.
    await db.$client.unsafe(`create function chaos_time_touch_now() returns trigger language plpgsql as $$
      begin new.updated_at := now(); return new; end $$`);
    await db.$client.unsafe(`create trigger chaos_time_touch_trigger before update on chaos_time_touch for each row execute function chaos_time_touch_now()`);
    await db.$client.unsafe(`insert into chaos_time_comments values ('c1', $1, '2026-11-09T12:00:00Z stays text')`, [new Date(NOON).toISOString()]);
    await db.$client.unsafe(`insert into chaos_time_touch values ('t1', $1)`, [new Date(NOON).toISOString()]);
    await db.$client.unsafe(`insert into chaos_time_runs values ('r1', 'running', $1, null, $2::jsonb, $3)`, [
      new Date(NOON + 20 * 60_000).toISOString(),
      JSON.stringify({ commentUpdatedAt: new Date(NOON).toISOString(), pgStyle: "2026-11-09 12:00:00.5+00", plain: "2026-11-09T12:00:00Z",
        wallMs: NOON, count: 42, version: 20_261_109, note: "not 2026-11-09T12:00:00Z", nested: [{ at: "2026-11-09T12:00:00.123456+05:30" }],
        holder: { processStartedAt: "2026-11-09T11:30:00.000Z", processStartedAtMs: NOON - 30 * 60_000 } }),
      new Date(NOON - 30 * 60_000).toISOString(),
    ]);
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
    if (evidenceDir) await rm(evidenceDir, { recursive: true, force: true });
  });

  it("moves every time back by the age, including copies inside JSON, and records what it moved", async () => {
    const age = 26 * HOUR;
    const result = await ageWaveDatabase({ connectionString: temporary.connectionString, faultId: "f01", ageMs: age, evidenceDir,
      waveStartedAt: NOON - HOUR, now: () => NOON + 30 * 60_000 });
    expect(result.triggersDisabled).toBe(true);
    expect(result.tables.map(table => table.table)).toEqual(expect.arrayContaining(["chaos_time_comments", "chaos_time_runs", "chaos_time_touch"]));

    const [comment] = await db.$client.unsafe(`select updated_at, body from chaos_time_comments`) as unknown as Array<{ updated_at: unknown; body: string }>;
    const [run] = await db.$client.unsafe(`select lease_expires_at, finished_at, context, controller_process_started_at from chaos_time_runs`) as unknown as Array<{
      lease_expires_at: unknown; finished_at: unknown; context: Record<string, unknown>; controller_process_started_at: unknown }>;
    const [touched] = await db.$client.unsafe(`select updated_at from chaos_time_touch`) as unknown as Array<{ updated_at: unknown }>;
    expect(ms(comment!.updated_at)).toBe(NOON - age);
    expect(comment!.body).toBe("2026-11-09T12:00:00Z stays text");
    expect(ms(touched!.updated_at)).toBe(NOON - age);
    // A deadline 20 minutes ahead is now long past.
    expect(ms(run!.lease_expires_at)).toBe(NOON + 20 * 60_000 - age);
    expect(run!.finished_at).toBeNull();
    // A copy of a time still equals the column it was copied from (continuation receipts compare them).
    expect(run!.context.commentUpdatedAt).toBe(new Date(ms(comment!.updated_at)).toISOString());
    expect(run!.context).toMatchObject({
      pgStyle: "2026-11-08 10:00:00.5+00", plain: "2026-11-08T10:00:00Z", wallMs: NOON - age, count: 42, version: 20_261_109,
      note: "not 2026-11-09T12:00:00Z", nested: [{ at: "2026-11-08T10:00:00.123456+05:30" }],
    });
    // Process start identity is not a deadline: the live owner must still match its saved stamp.
    expect(ms(run!.controller_process_started_at)).toBe(NOON - 30 * 60_000);
    expect(run!.context.holder).toEqual({ processStartedAt: "2026-11-09T11:30:00.000Z", processStartedAtMs: NOON - 30 * 60_000 });

    const evidence = JSON.parse(await readFile(result.evidencePath, "utf8")) as { ageMs: number; tables: Array<{ table: string; rows: number }> };
    expect(evidence.ageMs).toBe(age);
    expect(evidence.tables).toEqual(expect.arrayContaining([expect.objectContaining({ table: "chaos_time_runs", rows: 1 })]));

    // The grader reads the moved times back at their real time.
    const shift = { faultId: "f01", ageMs: age, appliedAt: NOON + 30 * 60_000, waveStartedAt: NOON - HOUR };
    expect(unshiftJson({ at: new Date(ms(comment!.updated_at)).toISOString() }, [shift])).toEqual({ at: new Date(NOON).toISOString() });
  });

  it("ages the same rows a second time and keeps every copy equal to its column", async () => {
    const age = 26 * HOUR;
    const second = await ageWaveDatabase({ connectionString: temporary.connectionString, faultId: "f02", ageMs: age, evidenceDir,
      waveStartedAt: NOON - HOUR, priorAgeMs: age, now: () => NOON + 40 * 60_000 });
    expect(second.waveStartedAt).toBe(NOON - HOUR);
    const [comment] = await db.$client.unsafe(`select updated_at from chaos_time_comments`) as unknown as Array<{ updated_at: unknown }>;
    const [run] = await db.$client.unsafe(`select context from chaos_time_runs`) as unknown as Array<{ context: Record<string, unknown> }>;
    expect(ms(comment!.updated_at)).toBe(NOON - 2 * age);
    expect(run!.context.commentUpdatedAt).toBe(new Date(NOON - 2 * age).toISOString());
    // The epoch copy was below the first window after one shift; the second window still reaches it.
    expect(run!.context.wallMs).toBe(NOON - 2 * age);
    expect(run!.context.count).toBe(42);
    const shifts = [{ faultId: "f01", ageMs: age, appliedAt: NOON + 30 * 60_000, waveStartedAt: NOON - HOUR },
      { faultId: "f02", ageMs: age, appliedAt: NOON + 40 * 60_000, waveStartedAt: NOON - HOUR }];
    expect(unshiftJson(run!.context, shifts)).toMatchObject({ commentUpdatedAt: new Date(NOON).toISOString(), wallMs: NOON });
  });

  it("refuses an age the wave has nearly outlived", async () => {
    await expect(ageWaveDatabase({ connectionString: temporary.connectionString, faultId: "f02", ageMs: HOUR, evidenceDir,
      waveStartedAt: NOON - HOUR, now: () => NOON })).rejects.toThrow(/too close to the age/);
  });
});
