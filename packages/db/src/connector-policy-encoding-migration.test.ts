import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const migration = "0355_agent_tool_definition_hooks.sql";
const company = "00000000-0000-4000-8000-000000000001";
const agent = "00000000-0000-4000-8000-000000000002";
const whitespace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

describePostgres("connector policy migration database encodings", () => {
  let database: EmbeddedPostgresTestDatabase | undefined;
  let utf8: ReturnType<typeof postgres> | undefined;
  let ascii: ReturnType<typeof postgres> | undefined;
  let asciiUrl: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-connector-encoding-");
    utf8 = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    await utf8.unsafe("CREATE DATABASE legacy_ascii TEMPLATE template0 ENCODING 'SQL_ASCII' LC_COLLATE 'C' LC_CTYPE 'C'");
    const url = new URL(database.connectionString);
    url.pathname = "/legacy_ascii";
    asciiUrl = url.toString();
    ascii = postgres(asciiUrl, { max: 1, onnotice: () => {} });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await Promise.all([utf8?.end(), ascii?.end()]);
    } finally {
      await database?.cleanup();
    }
  });

  it.each(["UTF8", "SQL_ASCII"])("migrates %s and matches JavaScript selector trimming", async (encoding) => {
    const sql = encoding === "UTF8" ? utf8! : ascii!;
    if (encoding === "SQL_ASCII") await applyPendingMigrations(asciiUrl);
    expect((await sql`SHOW server_encoding`)[0]?.server_encoding).toBe(encoding);
    for (const input of [...whitespace, whitespace, `${whitespace}${agent}${whitespace}`, "\u200b", "é", "中"]) {
      const actual = await sql`SELECT * FROM paperclip_connector_policy_targets(${company}::uuid, ${sql.json({ agentIds: input })})`;
      expect(Array.from(actual), JSON.stringify(input)).toEqual(input.trim()
        ? [{ target_type: "agent", target_id: input.trim() }]
        : [{ target_type: "company", target_id: company }]);
    }
    const arrays = await sql`SELECT * FROM paperclip_connector_policy_targets(${company}::uuid,
      ${sql.json({ agentIds: [whitespace, agent, ` ${agent} `, null, 12] })})`;
    expect(Array.from(arrays)).toEqual([
      { target_type: "agent", target_id: agent },
      { target_type: "agent", target_id: ` ${agent} ` },
    ]);
    const intersection = await sql`SELECT * FROM paperclip_connector_policy_targets(${company}::uuid,
      ${sql.json({ agentId: company, agentIds: [agent] })})`;
    expect(Array.from(intersection)).toEqual([]);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("recognizes the shipped receipt without replaying older connector triggers", async () => {
    const sql = utf8!;
    const content = await readFile(new URL(`./migrations/${migration}`, import.meta.url), "utf8");
    const hash = createHash("sha256").update(content).digest("hex");
    const originalHash = "7ac76adac0220da522c78e51da20490aeb0f90512b4370a05af9f8dd0f75eda6";
    const before = await sql`SELECT pg_get_functiondef('paperclip_connector_runtime_changed()'::regprocedure) AS definition`;
    const count = await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    await sql`UPDATE drizzle.__drizzle_migrations SET hash = ${originalHash} WHERE hash = ${hash}`;
    await applyPendingMigrations(database!.connectionString);
    expect((await inspectMigrations(database!.connectionString)).status).toBe("upToDate");
    expect(await sql`SELECT pg_get_functiondef('paperclip_connector_runtime_changed()'::regprocedure) AS definition`).toEqual(before);
    expect(await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`).toEqual(count);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
