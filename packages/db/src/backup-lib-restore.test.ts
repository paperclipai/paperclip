import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDatabaseRestore } from "./backup-lib.js";

const transport = vi.hoisted(() => ({ executed: [] as string[] }));
vi.mock("postgres", () => ({
  default: () => {
    const sql = async () => [];
    return Object.assign(sql, {
      unsafe: (statement: string) => ({
        execute: async () => {
          transport.executed.push(statement);
          return [];
        },
      }),
      end: async () => {},
    });
  },
}));

const BREAKPOINT = "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900";

describe("JavaScript restore statements", () => {
  let directory = "";
  const previousPsqlPath = process.env.PAPERCLIP_PSQL_PATH;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "backup-restore-statements-"));
    // No psql at this path, so the restore falls back to the JavaScript path.
    process.env.PAPERCLIP_PSQL_PATH = path.join(directory, "missing-psql");
    transport.executed = [];
  });

  afterEach(async () => {
    if (previousPsqlPath === undefined) delete process.env.PAPERCLIP_PSQL_PATH;
    else process.env.PAPERCLIP_PSQL_PATH = previousPsqlPath;
    await rm(directory, { recursive: true, force: true });
  });

  async function restore(body: string, gzip = false) {
    const backupFile = path.join(directory, gzip ? "backup.sql.gz" : "backup.sql");
    await writeFile(backupFile, gzip ? gzipSync(body) : body);
    await runDatabaseRestore({ connectionString: "postgres://unused/restore_test", backupFile });
    return transport.executed.splice(0);
  }

  it("keeps carriage returns inside literals", async () => {
    const jsonText = '{\r\n  "a": 1,\r  "b": [1,\r\n2]\r\n}';
    const textValue = "first line\r\nsecond line\rthird line\n";
    const insertJson = `INSERT INTO "public"."records" ("j") VALUES ($paperclip$${jsonText}$paperclip$);`;
    const insertText = `INSERT INTO "public"."notes" ("body") VALUES ($paperclip$${textValue}$paperclip$);`;
    const body = [
      "SET session_replication_role = replica;",
      BREAKPOINT,
      insertJson,
      BREAKPOINT,
      insertText,
      BREAKPOINT,
      "",
    ].join("\n");
    const expected = ["SET session_replication_role = replica;", insertJson, insertText];

    expect(await restore(body)).toEqual(expected);
    expect(await restore(body, true)).toEqual(expected);
  });

  it("keeps line endings across stream chunks and accepts a breakpoint line ending in CRLF", async () => {
    const longText = "x\r\n".repeat(60_000) + "end\r";
    const insert = `INSERT INTO "public"."notes" ("body") VALUES ($paperclip$${longText}$paperclip$);`;
    const body = `SELECT 0;\n${BREAKPOINT}\n${insert}\n${BREAKPOINT}\r\nSELECT 1;\n${BREAKPOINT}`;

    expect(await restore(body)).toEqual(["SELECT 0;", insert, "SELECT 1;"]);
  });
});
