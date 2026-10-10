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
const fixture = fileURLToPath(new URL("./__fixtures__/postgres-connection-recovery.mjs", import.meta.url));

describe.skipIf(!support.supported)("postgres connection recovery", () => {
  let database: EmbeddedPostgresTestDatabase;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-driver-recovery-");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await database?.cleanup(); });

  for (const format of ["esm", "cjs"]) {
    for (const scenario of ["transaction", "transaction-closed", "savepoint", "reserve", "transaction-queue", "reserve-queue"]) {
      it(`${format}: rejects disconnected ${scenario} work and recovers the pool`, async () => {
        // A driver timer used to crash the whole process. A child also detects
        // hangs without leaving broken connections in the Vitest worker.
        const { stdout, stderr } = await run(process.execPath, [fixture], {
          env: {
            ...process.env,
            TEST_DATABASE_URL: database.connectionString,
            DRIVER_FORMAT: format,
            RECOVERY_CASE: scenario,
          },
          timeout: 15_000,
        });
        expect(stdout.trim()).toBe("recovered");
        expect(stderr).toBe("");
      }, 20_000);
    }
  }
});
