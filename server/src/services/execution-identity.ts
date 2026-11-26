import { sql, type SQL } from "drizzle-orm";

export function canonicalExecutionUuid(text: SQL): SQL<string | null> {
  return sql<string | null>`case when ${text} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (${text})::uuid end`;
}
