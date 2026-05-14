import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema/index.js";

export type BrainDb = ReturnType<typeof drizzle<typeof schema>>;

export interface BrainDbHandle {
  db: BrainDb;
  sql: ReturnType<typeof postgres>;
  close: () => Promise<void>;
}

export function createBrainDb(connectionString: string, opts: { max?: number } = {}): BrainDbHandle {
  const sql = postgres(connectionString, {
    max: opts.max ?? 4,
    prepare: false,
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
