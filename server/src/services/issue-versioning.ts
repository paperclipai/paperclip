import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";

export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | DbTransaction;

export class IssueVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super("Issue version conflict");
  }
}

export type IssueMutationPatch = Omit<
  Partial<typeof issues.$inferInsert>,
  "id" | "version" | "updatedAt"
>;
type VersionedIssuePatchInput = {
  [Key in keyof IssueMutationPatch]: IssueMutationPatch[Key] | SQL;
};

export type IssueMutationPlan<T> = {
  issuePatch?: IssueMutationPatch;
  result: T;
};

export type IssueMutationResult<T> = {
  issue: typeof issues.$inferSelect;
  result: T;
};

export type RunIssueMutationInput<T> = {
  issueId: string;
  expectedVersion?: number;
  now?: Date;
  mutate: (
    tx: DbTransaction,
    issue: typeof issues.$inferSelect,
  ) => Promise<IssueMutationPlan<T>> | IssueMutationPlan<T>;
};

function isDbTransaction(dbOrTx: DbOrTx): dbOrTx is DbTransaction {
  return "rollback" in dbOrTx;
}

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

export async function bumpIssueVersions(
  dbOrTx: DbOrTx,
  issueIds: string[],
  now = new Date(),
): Promise<string[]> {
  const distinctIssueIds = [...new Set(issueIds)];
  if (distinctIssueIds.length === 0) return [];

  return await dbOrTx
    .update(issues)
    .set(versionedIssuePatch({}, now))
    .where(inArray(issues.id, distinctIssueIds))
    .returning({ id: issues.id })
    .then((rows) => rows.map((row) => row.id));
}

async function runInTransaction<T>(
  tx: DbTransaction,
  { issueId, expectedVersion, now, mutate }: RunIssueMutationInput<T>,
): Promise<IssueMutationResult<T> | null> {
  const current = await tx
    .select()
    .from(issues)
    .where(eq(issues.id, issueId))
    .for("update")
    .then((rows) => rows[0] ?? null);

  if (!current) return null;
  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    throw new IssueVersionConflictError(current.version);
  }

  const planned = await mutate(tx, current);
  const updated = await tx
    .update(issues)
    .set(versionedIssuePatch(planned.issuePatch ?? {}, now))
    .where(and(eq(issues.id, issueId), eq(issues.version, current.version)))
    .returning()
    .then((rows) => rows[0] ?? null);

  if (!updated) throw new Error("Locked issue version update returned no row");
  return { issue: updated, result: planned.result };
}

export async function runIssueMutation<T>(
  dbOrTx: DbOrTx,
  input: RunIssueMutationInput<T>,
): Promise<IssueMutationResult<T> | null> {
  if (isDbTransaction(dbOrTx)) {
    return await runInTransaction(dbOrTx, input);
  }
  return await dbOrTx.transaction(async (tx) => await runInTransaction(tx, input));
}
