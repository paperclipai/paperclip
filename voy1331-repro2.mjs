//!/usr/bin/env node
// Reproduce the exact searchPublished error against the running embedded PG
// This uses drizzle-orm/postgres-js with the EXACT same setup as the server
import postgres from "./node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/index.js";
import { drizzle as drizzlePg } from "./node_modules/.pnpm/drizzle-orm@0.45.2_@electric-sql+pglite@0.3.15_kysely@0.29.2_pg@8.18.0_postgres@3.4.9_sqlite3@5.1.7/node_modules/drizzle-orm/postgres-js/driver.cjs";

const CONNECTION = "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";

async function main() {
  // Create EXACT same setup as createDb
  const pgClient = postgres(CONNECTION);
  const db = drizzlePg(pgClient);

  // Build the exact query from searchPublished
  const companyId = "ce49ee2f-48ea-43f1-99c3-fd78c119f32e";
  const query = "deploy";
  const searchLimit = 10;

  // The searchPublished function uses drizzle ORM which produces table-qualified columns
  // Let me try using the raw SQL tagged template (same as searchPublished's sql`` usage)
  // but with a simpler pattern first

  console.log("=== Test 1: Simple tagged template query ===");
  try {
    const rows = await db.execute(
      pgClient`SELECT 3 AS ok`
    );
    console.log("  Works:", rows?.[0]?.ok ?? JSON.stringify(rows));
  } catch (err) {
    console.error("  FAILED:", err.message || err);
  }

  // Now test with unsafe — same pattern searchPublished uses
  console.log("\n=== Test 2: unsafe SELECT query ===");
  try {
    const searchSql = `
      SELECT "id", "title", "summary",
        ts_rank(
          to_tsvector('english', "title" || ' ' || coalesce("body", '')),
          plainto_tsquery('english', $1)
        ) as "score"
      FROM "knowledge_documents"
      WHERE "company_id" = $2
        AND "status" = $3
        AND to_tsvector('english', "title" || ' ' || coalesce("body", '')) @@ plainto_tsquery('english', $4)
      ORDER BY "score" DESC
      LIMIT $5
    `;
    const rows = await db.execute(
      pgClient.unsafe(searchSql, [query, companyId, "published", query, searchLimit])
    );
    console.log("  Works: rows =", rows?.length ?? JSON.stringify(rows));
  } catch (err) {
    console.error("  FAILED:", err.message || err);
    if (err.code) console.error("  Code:", err.code);
    if (err.severity) console.error("  Severity:", err.severity);
  }

  // Test with drizzle query builder (no table schema)
  console.log("\n=== Test 3: Drizzle query builder style ===");
  try {
    const result = await db.select({
      score: pgClient`ts_rank(
        to_tsvector('english', "title" || ' ' || coalesce("body", '')),
        plainto_tsquery('english', ${query})
      )`
    })
    .from(pgClient`"knowledge_documents"`)
    .where(pgClient`"company_id" = ${companyId} AND "status" = 'published' AND to_tsvector('english', "title" || ' ' || coalesce("body", '')) @@ plainto_tsquery('english', ${query})`)
    .orderBy(pgClient`score DESC`)
    .limit(searchLimit);
    
    console.log("  Works: rows =", result?.length ?? JSON.stringify(result));
  } catch (err) {
    console.error("  FAILED:", err.message || err);
    console.error("  Full:", JSON.stringify(err, Object.getOwnPropertyNames(err)));
  }

  // Test with drizzle query builder using known-column expressions
  console.log("\n=== Test 4: Drizzle query builder with SQL as column refs ===");
  try {
    const result = await db.select({
      id: pgClient`"id"`,
      title: pgClient`"title"`,
      summary: pgClient`"summary"`,
      score: pgClient`ts_rank(
        to_tsvector('english', "title" || ' ' || coalesce("body", '')),
        plainto_tsquery('english', ${query})
      )`
    })
    .from(pgClient`"knowledge_documents"`)
    .where(pgClient`"company_id" = ${companyId} AND "status" = 'published' AND to_tsvector('english', "title" || ' ' || coalesce("body", '')) @@ plainto_tsquery('english', ${query})`)
    .orderBy(pgClient`score DESC`)
    .limit(searchLimit);
    
    console.log("  Works: rows =", result?.length ?? JSON.stringify(result));
    if (result?.length > 0) {
      console.log("  First:", JSON.stringify(result[0]));
    }
  } catch (err) {
    console.error("  FAILED:", err.message || err);
    if (err.code) console.error("  Code:", err.code);
    if (err.severity) console.error("  Severity:", err.severity);
    if (err.query) console.error("  Query:", err.query);
    if (err.parameters) console.error("  Params:", err.parameters);
  }

  await pgClient.end();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exitCode = 1;
});