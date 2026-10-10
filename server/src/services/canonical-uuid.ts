import { sql, type SQL } from "drizzle-orm";

/** Preserve UUID::text equality while allowing lookups on an indexed UUID column.
 * PostgreSQL accepts other UUID spellings; legacy text joins did not. CASE also
 * keeps malformed persisted JSON from reaching the cast, regardless of join order.
 */
export function canonicalUuidFromText(value: SQL): SQL<string | null> {
  return sql`case when ${value} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (${value})::uuid end`;
}
