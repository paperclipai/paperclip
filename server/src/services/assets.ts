import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assets } from "@paperclipai/db";

// Loose UUID shape check (any version) so non-UUID refs such as "x" never reach
// the uuid-typed column, where Postgres would throw "invalid input syntax for
// type uuid" and surface an HTTP 500 instead of a not-found.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assetService(db: Db) {
  return {
    create: (companyId: string, data: Omit<typeof assets.$inferInsert, "companyId">) =>
      db
        .insert(assets)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    getById: async (id: string) => {
      if (!UUID_RE.test(id)) return null;
      return db
        .select()
        .from(assets)
        .where(eq(assets.id, id))
        .then((rows) => rows[0] ?? null);
    },
  };
}
