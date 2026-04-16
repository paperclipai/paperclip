import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-rt2-task-persistence-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres RT2 task persistence tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("RT2 task persistence migrations", () => {
  it(
    "creates task profile and participant tables",
    async () => {
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

      try {
        const [tables] = await sql.unsafe<Array<{
          task_profiles: string | null;
          task_participants: string | null;
        }>>(`
          SELECT
            to_regclass('public.rt2_v33_task_profiles') AS task_profiles,
            to_regclass('public.rt2_v33_task_participants') AS task_participants
        `);

        expect(tables).toEqual({
          task_profiles: "rt2_v33_task_profiles",
          task_participants: "rt2_v33_task_participants",
        });
      } finally {
        await sql.end();
      }
    },
    20_000,
  );
});
