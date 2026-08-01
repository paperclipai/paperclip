import { sql, type SQL } from "drizzle-orm";
import { issues } from "./schema/issues.js";

export type IssueMutationPatch = Omit<
  Partial<typeof issues.$inferInsert>,
  "id" | "version" | "updatedAt"
>;

export type VersionedIssuePatchInput = {
  [Key in keyof IssueMutationPatch]: IssueMutationPatch[Key] | SQL;
};

export function versionedIssuePatch(
  patch: VersionedIssuePatchInput,
  now = new Date(),
) {
  return {
    ...patch,
    updatedAt: now,
    version: sql`${issues.version} + 1`,
  };
}
