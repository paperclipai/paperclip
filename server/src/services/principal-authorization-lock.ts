import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { PrincipalType } from "@paperclipai/shared";

const PRINCIPAL_AUTHORIZATION_LOCK_NAMESPACE = "paperclip:principal-authorization";
const COMPANY_AUTHORIZATION_LOCK_NAMESPACE = "paperclip:company-authorization";

export async function lockCompanyAuthorization(
  db: Pick<Db, "execute">,
  companyIds: string | string[],
) {
  for (const companyId of [...new Set(Array.isArray(companyIds) ? companyIds : [companyIds])].sort()) {
    await db.execute(sql`
      select pg_advisory_xact_lock(
        hashtext(${COMPANY_AUTHORIZATION_LOCK_NAMESPACE}),
        hashtext(${companyId})
      )
    `);
  }
}

/**
 * Serializes authorization-sensitive work for one principal.
 *
 * Callers must acquire these transaction-scoped locks before any membership or
 * permission-grant row lock, read, or write that participates in an atomic
 * authorization decision. Principal-scoped paths take the principal lock
 * first, followed by company locks in lexical order. Company-wide revocation
 * takes only the company lock and never acquires a principal lock afterward.
 * The company lock also serializes writers for different principals before
 * they take company-wide membership row locks.
 */
export async function lockPrincipalAuthorization(
  db: Pick<Db, "execute">,
  principalType: PrincipalType,
  principalId: string,
  companyIds: string | string[],
) {
  await db.execute(sql`
    select pg_advisory_xact_lock(
      hashtext(${PRINCIPAL_AUTHORIZATION_LOCK_NAMESPACE}),
      hashtext(${`${principalType}:${principalId}`})
    )
  `);
  await lockCompanyAuthorization(db, companyIds);
}
