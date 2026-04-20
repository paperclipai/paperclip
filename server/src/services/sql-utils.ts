import { sql, type SQL } from "drizzle-orm";

// SQL_ASCII clusters count bytes not chars in left()/length(). Round-tripping through
// convert_to/convert_from forces UTF-8 character semantics so the cut never splits a
// multi-byte sequence and avoids "invalid byte sequence for encoding UTF8" 500 errors.
export function utf8Trunc(expr: SQL, maxChars: number): SQL<string | null> {
  return sql<string | null>`left(convert_from(convert_to(${expr}, 'SQL_ASCII'), 'UTF8'), ${maxChars})`;
}
