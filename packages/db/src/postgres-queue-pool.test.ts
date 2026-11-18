import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const run = promisify(execFile);
const fixture = fileURLToPath(new URL("./__fixtures__/postgres-queue-pool.mjs", import.meta.url));

describe.skipIf(!support.supported)("postgres connection queue in a busy pool", () => {
  let database: EmbeddedPostgresTestDatabase;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-driver-queue-pool-");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await database?.cleanup(); });

  for (const format of ["esm", "cjs"]) {
    it(`${format}: dispatching a query scans only live connections while idle ones stay open`, async () => {
      const connections = 24;
      const { stdout, stderr } = await run(process.execPath, [fixture], {
        env: {
          ...process.env,
          TEST_DATABASE_URL: database.connectionString,
          DRIVER_FORMAT: format,
          QUERIES: "20000",
          CONNECTIONS: String(connections),
          CONCURRENCY: "8",
        },
        timeout: 60_000,
      });
      expect(stderr).toBe("");
      const result = JSON.parse(stdout) as { queries: number; windows: Array<{ maxScan: number }> };
      expect(result.queries).toBe(20_000);
      for (const window of result.windows) expect(window.maxScan).toBeLessThanOrEqual(connections);
    }, 70_000);
  }
});
