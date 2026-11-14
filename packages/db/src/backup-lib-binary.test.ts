import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { runDatabaseBackup } from "./backup-lib.js";

const transport = vi.hoisted(() => ({ rows: [] as unknown[][], projection: "", end: vi.fn() }));
vi.mock("postgres", () => ({
  default: () => {
    const columns = [
      { column_name: "bytes", data_type: "bytea", udt_name: "bytea", udt_schema: "pg_catalog" },
      { column_name: "payloads", data_type: "ARRAY", udt_name: "_bytea", udt_schema: "pg_catalog" },
      { column_name: "metadata", data_type: "jsonb", udt_name: "jsonb", udt_schema: "pg_catalog" },
      { column_name: "redacted", data_type: "ARRAY", udt_name: "_bytea", udt_schema: "pg_catalog" },
    ];
    const sql = async (parts: TemplateStringsArray) => {
      const query = parts.join("?");
      if (query.includes("FROM information_schema.tables")) return [{ schema_name: "public", tablename: "binary_fixture" }];
      if (query.includes("FROM information_schema.columns")) return columns.map(column => ({ ...column, udt_schema: "pg_catalog", is_nullable: "YES", is_identity: "NO", column_default: null }));
      return [];
    };
    return Object.assign(sql, {
      end: transport.end,
      unsafe: (query: string) => query.startsWith("SELECT count(*)") ? Promise.resolve([{ n: transport.rows.length }])
        : query.startsWith("SELECT ") && query.includes('FROM "public"."binary_fixture"')
          ? { values: () => ({ cursor: async function* () { transport.projection = query; yield transport.rows; } }) }
          : query,
    });
  },
}));

describe("JavaScript backup binary SQL", () => {
  it("writes exact binary scalars and nested arrays without changing JSON or redaction", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "backup-binary-sql-"));
    const binary = Buffer.from([0, 255, ...Buffer.from("雪")]);
    const metadata = { bytes: binary, values: [null, "雪"] };
    const hex = binary.toString("hex");
    const payloads = `{"\\\\x${hex}","\\\\x",NULL}`;
    const boundedPayloads = `[0:1][3:4]={{"\\\\x${hex}",NULL},{"\\\\x","\\\\x00ff"}}`;
    transport.rows = [
      [binary, payloads, metadata, payloads],
      [new Uint8Array(), "{}", [], payloads],
      [null, null, null, payloads],
      [new Uint8Array([0, 255]), boundedPayloads, {}, boundedPayloads],
    ];
    transport.end.mockClear();
    try {
      const archive = await runDatabaseBackup({ connectionString: "postgres://unused/binary_test", backupDir: directory,
        backupEngine: "javascript", retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
        nullifyColumns: { binary_fixture: ["redacted"] } });
      const body = gunzipSync(await readFile(archive.backupFile)).toString("utf8");
      const inserts = body.split("\n").filter(line => line.startsWith("INSERT INTO"));
      const literal = (value: string) => `$paperclip$${value}$paperclip$`;
      const array = (value: string) => literal(value);
      const prefix = 'INSERT INTO "public"."binary_fixture" ("bytes", "payloads", "metadata", "redacted") VALUES ';
      expect(inserts).toEqual([
        `${prefix}(decode('${hex}', 'hex'), ${array(`{"\\\\x${hex}","\\\\x",NULL}`)}, ${literal(JSON.stringify(metadata))}, NULL);`,
        `${prefix}(decode('', 'hex'), ${array("{}")}, ${literal("[]")}, NULL);`,
        `${prefix}(NULL, NULL, NULL, NULL);`,
        `${prefix}(decode('00ff', 'hex'), ${array(boundedPayloads)}, ${literal("{}")}, NULL);`,
      ]);
      expect(transport.projection).toBe('SELECT "bytes", "payloads"::text AS "payloads", "metadata", "redacted"::text AS "redacted" FROM "public"."binary_fixture"');
      expect(transport.end).toHaveBeenCalledTimes(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
