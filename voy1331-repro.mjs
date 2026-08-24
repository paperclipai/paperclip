//!/usr/bin/env node
// Connect to the running embedded PG and test the search query
// Direct ESM script — run from root with tsx

import postgres from "./node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/index.js";

const CONNECTION = "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";

async function main() {
  const sql = postgres(CONNECTION);

  // First test: simple query protocol (no params) - should work
  console.log("=== Test 1: Simple query protocol (no params) ===");
  try {
    const rows = await sql`SELECT 1 AS ok`;
    console.log("  Simple query works: rows[0].ok =", rows[0]?.ok);
  } catch (err) {
    console.error("  Simple query FAILED:", err);
  }

  // Second test: unsafe() with no params (simple query protocol)
  console.log("\n=== Test 2: unsafe() with no params ===");
  try {
    const rows = await sql.unsafe("SELECT 2 AS ok", []);
    console.log("  unsafe(no params) works: rows[0].ok =", rows[0]?.ok);
  } catch (err) {
    console.error("  unsafe(no params) FAILED:", err);
  }

  // Third test: unsafe() with params (extended query protocol)
  console.log("\n=== Test 3: unsafe() with params ===");
  try {
    const rows = await sql.unsafe("SELECT $1::int AS val", [42]);
    console.log("  unsafe(params) works: rows[0].val =", rows[0]?.val);
  } catch (err) {
    console.error("  unsafe(params) FAILED:", err);
  }

  // Fourth test: search-shaped query with params
  console.log("\n=== Test 4: Search-shaped query with params ===");
  const query = "deploy";
  const companyId = "ce49ee2f-48ea-43f1-99c3-fd78c119f32e";
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
    const rows = await sql.unsafe(searchSql, [query, companyId, "published", query, 10]);
    console.log("  Search query works: rows =", rows.length);
  } catch (err) {
    console.error("  Search query FAILED:", err.message || err);
    if (err.query) console.error("  Query:", err.query.slice(0, 200));
    if (err.parameters) console.error("  Params:", err.parameters);
    if (err.code) console.error("  Code:", err.code, "Severity:", err.severity);
  }

  // Fifth test: with drizzle's serializer overrides
  console.log("\n=== Test 5: With drizzle serializer overrides ===");
  const transparentParser = (val) => val;
  for (const type of ["1184", "1082", "1083", "1114", "1182", "1185", "1115", "1231"]) {
    sql.options.parsers[type] = transparentParser;
    sql.options.serializers[type] = transparentParser;
  }
  sql.options.serializers["114"] = transparentParser;
  sql.options.serializers["3802"] = transparentParser;

  try {
    const searchSql2 = `
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
    const rows = await sql.unsafe(searchSql2, [query, companyId, "published", query, 10]);
    console.log("  Search query with serializers works: rows =", rows.length);
  } catch (err) {
    console.error("  Search query with serializers FAILED:", err.message || err);
    if (err.query) console.error("  Query:", err.query?.slice(0, 200));
    if (err.parameters) console.error("  Params:", err.parameters);
    if (err.code) console.error("  Code:", err.code, "Severity:", err.severity);
  }

  await sql.end();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exitCode = 1;
});