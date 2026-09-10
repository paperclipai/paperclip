import { and, eq, inArray } from "drizzle-orm";
import { deliveryFindings, type Db } from "@paperclipai/db";
import type { GreptileFinding } from "./greptile.js";

/**
 * Persisted review findings.
 *
 * One store owns how a governed read becomes durable evidence so the reconcile
 * path, the merge path and the operator-facing review read all present the same
 * findings, states and head provenance.
 */

/**
 * Record the findings a governed read observed for `headSha`.
 *
 * Rules, in precedence order:
 *
 * 1. A human `disputed` disposition holds. A dispute blocks and is never
 *    cleared by the provider's own flag or by a later read.
 * 2. A finding the provider reports as addressed is recorded
 *    `already_addressed` and never reopens while it stays flagged.
 * 3. Any other finding the provider still reports reopens, because it is
 *    reported on the snapshot just read.
 * 4. An open finding that this snapshot no longer reports goes `stale` — it
 *    never silently clears, and dispositions are never erased by an empty
 *    snapshot.
 */
export async function recordObservedFindings(
  db: Db,
  input: {
    companyId: string;
    unitId: string;
    /** Revision the snapshot belongs to; `null` skips the stale sweep. */
    headSha: string | null;
    findings: GreptileFinding[];
  },
): Promise<void> {
  const now = new Date();
  const reportedIds: string[] = [];
  for (const finding of input.findings) {
    reportedIds.push(finding.externalId);
    const [existing] = await db
      .select({ id: deliveryFindings.id, state: deliveryFindings.state })
      .from(deliveryFindings)
      .where(and(
        eq(deliveryFindings.companyId, input.companyId),
        eq(deliveryFindings.unitId, input.unitId),
        eq(deliveryFindings.externalId, finding.externalId),
      ))
      .limit(1);
    const providerAddressed = finding.addressed === true;
    const state: (typeof deliveryFindings.$inferSelect)["state"] = existing?.state === "disputed"
      ? "disputed"
      : providerAddressed
        ? "already_addressed"
        : "open";
    const values = {
      severity: finding.severity,
      title: finding.title,
      body: finding.body,
      filePath: finding.filePath,
      line: finding.line,
      url: finding.url,
      headSha: input.headSha,
      state,
      lastSeenAt: now,
      updatedAt: now,
    };
    if (existing) {
      await db.update(deliveryFindings).set(values).where(eq(deliveryFindings.id, existing.id));
    } else {
      await db
        .insert(deliveryFindings)
        .values({
          companyId: input.companyId,
          unitId: input.unitId,
          source: "greptile",
          externalId: finding.externalId,
          ...values,
          firstSeenAt: now,
        })
        .onConflictDoNothing();
    }
  }
  if (input.headSha === null) return;
  const openRows = await db
    .select({ id: deliveryFindings.id, externalId: deliveryFindings.externalId })
    .from(deliveryFindings)
    .where(and(
      eq(deliveryFindings.companyId, input.companyId),
      eq(deliveryFindings.unitId, input.unitId),
      eq(deliveryFindings.state, "open"),
    ));
  const staleIds = openRows
    .filter((row) => !reportedIds.includes(row.externalId))
    .map((row) => row.id);
  if (staleIds.length > 0) {
    await db
      .update(deliveryFindings)
      .set({ state: "stale", updatedAt: now })
      .where(inArray(deliveryFindings.id, staleIds));
  }
}
