import { beforeEach, describe, expect, it, vi } from "vitest";

const { postgresFactory, readFileMock } = vi.hoisted(() => ({
  postgresFactory: vi.fn(),
  readFileMock: vi.fn(),
}));

vi.mock("postgres", () => ({
  default: postgresFactory,
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readFile: readFileMock,
  };
});

const { restoreDatabaseBackup } = await import("./backup-lib.js");

function createMockSql() {
  const tagged = vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => [] as unknown[]);
  const unsafe = vi.fn(async (_statement: string) => [] as unknown[]);
  const end = vi.fn(async () => undefined);
  return Object.assign(tagged, { unsafe, end });
}

beforeEach(() => {
  postgresFactory.mockReset();
  readFileMock.mockReset();
});

describe("restoreDatabaseBackup", () => {
  it("precreates referenced sequences and reapplies deferred statements after data blocks", async () => {
    const sqlContent = [
      "BEGIN;",
      `CREATE TABLE "users" ("id" integer DEFAULT nextval('public.users_id_seq'::regclass), "org_id" integer DEFAULT nextval('"public"."orgs_id_seq"'::regclass));`,
      "",
      "-- Foreign keys",
      `ALTER TABLE "users" ADD CONSTRAINT "users_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "orgs" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;`,
      "",
      "-- Unique constraints",
      `ALTER TABLE "users" ADD CONSTRAINT "users_org_id_unique" UNIQUE ("org_id");`,
      "",
      "-- Indexes",
      `CREATE INDEX "users_org_id_idx" ON "users" ("org_id");`,
      "",
      "-- Data for: users",
      `INSERT INTO "users" ("id", "org_id") VALUES (1, 1);`,
      "",
      "COMMIT;",
    ].join("\n");

    readFileMock.mockResolvedValue(sqlContent);
    const sql = createMockSql();
    postgresFactory.mockReturnValue(sql);

    const result = await restoreDatabaseBackup({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      backupFile: "/tmp/paperclip.sql",
    });

    expect(result).toEqual({
      backupFile: "/tmp/paperclip.sql",
      sizeBytes: Buffer.byteLength(sqlContent, "utf8"),
    });
    expect(postgresFactory).toHaveBeenCalledWith(
      "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      { max: 1, connect_timeout: 5 },
    );
    expect(sql).toHaveBeenCalledTimes(1);
    expect(sql.unsafe).toHaveBeenNthCalledWith(1, "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    expect(sql.unsafe).toHaveBeenNthCalledWith(2, 'CREATE SEQUENCE IF NOT EXISTS "public"."orgs_id_seq";');
    expect(sql.unsafe).toHaveBeenNthCalledWith(3, 'CREATE SEQUENCE IF NOT EXISTS "public"."users_id_seq";');

    const appliedSqlCall = sql.unsafe.mock.calls[3];
    expect(appliedSqlCall).toBeDefined();
    const appliedSql = appliedSqlCall![0] as string;
    expect(appliedSql.indexOf("-- Data for: users")).toBeLessThan(appliedSql.indexOf("-- Foreign keys"));
    expect(appliedSql.indexOf("-- Foreign keys")).toBeLessThan(appliedSql.indexOf("-- Unique constraints"));
    expect(appliedSql.indexOf("-- Unique constraints")).toBeLessThan(appliedSql.indexOf("-- Indexes"));
    expect(appliedSql.indexOf("-- Indexes")).toBeLessThan(appliedSql.indexOf("COMMIT;"));
    expect(sql.end).toHaveBeenCalledTimes(1);
  });

  it("skips dropping the public schema when dropExistingSchema is false", async () => {
    readFileMock.mockResolvedValue("BEGIN;\nCOMMIT;\n");
    const sql = createMockSql();
    postgresFactory.mockReturnValue(sql);

    await restoreDatabaseBackup({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      backupFile: "/tmp/paperclip.sql",
      dropExistingSchema: false,
      connectTimeoutSeconds: 12,
    });

    expect(postgresFactory).toHaveBeenCalledWith(
      "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      { max: 1, connect_timeout: 12 },
    );
    expect(sql.unsafe).toHaveBeenCalledTimes(1);
    expect(sql.unsafe).not.toHaveBeenCalledWith("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    expect(sql.end).toHaveBeenCalledTimes(1);
  });

  it("always closes the database connection when restore application fails", async () => {
    readFileMock.mockResolvedValue("BEGIN;\nBROKEN;\nCOMMIT;\n");
    const sql = createMockSql();
    sql.unsafe.mockImplementation(async (statement: string) => {
      if (statement.includes("BROKEN")) {
        throw new Error("restore failed");
      }
      return [];
    });
    postgresFactory.mockReturnValue(sql);

    await expect(
      restoreDatabaseBackup({
        connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
        backupFile: "/tmp/paperclip.sql",
      }),
    ).rejects.toThrow("restore failed");

    expect(sql.end).toHaveBeenCalledTimes(1);
  });
});
