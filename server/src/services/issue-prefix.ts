import { and, eq, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { cases, companies, issues } from "@paperclipai/db";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Read surface shared by the root client and a transaction handle. */
export type IssuePrefixReadDb = Pick<Db | DbTransaction, "select">;
/** Write surface shared by the root client and a transaction handle. */
export type IssuePrefixWriteDb = Pick<Db | DbTransaction, "update">;

/** Prefix used when a company name has no letters to derive from. */
export const ISSUE_PREFIX_FALLBACK = "CMP";

/**
 * Upper bound on suffix attempts. The suffix is a run of "A" characters, so
 * the loop is bounded to keep a pathological data set from spinning forever.
 */
export const MAX_ISSUE_PREFIX_ATTEMPTS = 10_000;

/**
 * The letters a company name contributes to its issue prefix.
 *
 * The result is always `[A-Z]{1,3}`, which matters for
 * {@link pickAvailableIssuePrefix}: the base is interpolated into a LIKE
 * pattern, and letters carry no LIKE metacharacters.
 */
export function deriveIssuePrefixBase(name: string) {
  const normalized = name.toUpperCase().replace(/[^A-Z]/g, "");
  return normalized.slice(0, 3) || ISSUE_PREFIX_FALLBACK;
}

/** Disambiguating suffix for the nth allocation attempt: "", "A", "AA", ... */
export function issuePrefixSuffixForAttempt(attempt: number) {
  if (attempt <= 1) return "";
  return "A".repeat(attempt - 1);
}

/**
 * Detects the issue-prefix unique violation through Drizzle's wrapper errors.
 *
 * Drizzle re-throws driver errors inside a `DrizzleQueryError`, so the real
 * `23505` sits somewhere down the `.cause` chain. The `seen` set guards
 * against a self-referential chain.
 */
export function isIssuePrefixConflict(error: unknown) {
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const maybe = current as { code?: string; constraint?: string; constraint_name?: string; cause?: unknown };
    const constraint = maybe.constraint ?? maybe.constraint_name;
    if (maybe.code === "23505" && constraint === "companies_issue_prefix_idx") {
      return true;
    }
    current = maybe.cause;
  }
  return false;
}

/**
 * Returns the first free `${base}${suffix}` prefix, or null when the whole
 * suffix space is taken.
 *
 * A standalone INSERT can simply retry on the unique violation, because each
 * failed statement is its own implicit transaction. Inside an explicit
 * transaction it cannot: a unique violation aborts the whole transaction, so
 * every later statement fails with "current transaction is aborted". Callers
 * that already hold a transaction must therefore pick first and then write.
 * That leaves a small race — another company can claim the same prefix between
 * this read and the caller's UPDATE — and the loser sees the unique violation
 * surface from its own statement. The write is client-retryable, and the
 * collision only happens when two companies are renamed onto the same base at
 * the same moment.
 *
 * Prefixes are read from the companies table alone. An orphan identifier left
 * behind by a partially applied re-key would not be visible here, and the
 * caller would see the identifier unique index reject the write instead.
 */
export async function pickAvailableIssuePrefix(
  database: IssuePrefixReadDb,
  base: string,
): Promise<string | null> {
  const taken = new Set(
    await database
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      // An exact head comparison rather than LIKE, so a base is never read as a
      // pattern. `deriveIssuePrefixBase` cannot produce a LIKE metacharacter,
      // but this helper does not get to assume its caller used it.
      .where(sql`left(${companies.issuePrefix}, ${base.length}::int) = ${base}`)
      .then((rows) => rows.map((row) => row.issuePrefix)),
  );
  for (let attempt = 1; attempt <= MAX_ISSUE_PREFIX_ATTEMPTS; attempt += 1) {
    const candidate = `${base}${issuePrefixSuffixForAttempt(attempt)}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Rewrites the stored issue and case identifiers of one company onto a new
 * prefix.
 *
 * Issue identifiers mint as `${prefix}-${issueNumber}` and case identifiers as
 * `${prefix}-C${caseNumber}`, so both start with `${prefix}-` and one head
 * comparison covers both tables. Only the prefix is replaced; the separator and
 * the number after it are preserved. The statements run in the caller's
 * transaction so the company row and its identifiers move together.
 */
export async function rekeyCompanyIssueIdentifiers(
  tx: IssuePrefixWriteDb,
  input: { companyId: string; fromPrefix: string; toPrefix: string },
): Promise<{ issues: number; cases: number }> {
  const { companyId, fromPrefix, toPrefix } = input;
  if (fromPrefix === toPrefix) return { issues: 0, cases: 0 };

  const legacyHead = `${fromPrefix}-`;
  // An exact head comparison rather than LIKE, so a stored prefix is never read
  // as a pattern.
  const matchesLegacyHead = (identifier: PgColumn) =>
    sql`left(${identifier}, ${legacyHead.length}::int) = ${legacyHead}`;
  // 1-based index of the "-" that follows the prefix, so the tail keeps its
  // separator and number. The `::int` cast is load-bearing: the driver binds
  // the parameter as text, and `substring(text from text)` is the SQL-regex
  // overload, which returns NULL for a non-pattern argument.
  const tailStart = sql`${fromPrefix.length + 1}::int`;

  const rekeyedIssues = await tx
    .update(issues)
    .set({ identifier: sql`${toPrefix} || substring(${issues.identifier} from ${tailStart})` })
    .where(and(eq(issues.companyId, companyId), matchesLegacyHead(issues.identifier)))
    .returning({ id: issues.id });

  const rekeyedCases = await tx
    .update(cases)
    .set({ identifier: sql`${toPrefix} || substring(${cases.identifier} from ${tailStart})` })
    .where(and(eq(cases.companyId, companyId), matchesLegacyHead(cases.identifier)))
    .returning({ id: cases.id });

  return { issues: rekeyedIssues.length, cases: rekeyedCases.length };
}
