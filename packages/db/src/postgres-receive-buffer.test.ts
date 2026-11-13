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
const fixture = fileURLToPath(new URL("./__fixtures__/postgres-receive-buffer.mjs", import.meta.url));

describe.skipIf(!support.supported)("postgres receive buffer", () => {
  let database: EmbeddedPostgresTestDatabase;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-driver-receive-buffer-");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await database?.cleanup(); });

  for (const format of ["esm", "cjs"]) {
    for (const chunking of ["socket", "message", "straddle"]) {
      it(`${format}: reassembles ${chunking}-chunked results and releases the buffer once the connection is idle`, async () => {
        const { stdout, stderr } = await run(process.execPath, ["--expose-gc", fixture], {
          env: { ...process.env, TEST_DATABASE_URL: database.connectionString, DRIVER_FORMAT: format, CHUNKING: chunking },
          timeout: 60_000,
        });
        expect(stdout.trim()).toBe("released");
        expect(stderr).toBe("");
      }, 70_000);
    }
  }
});
