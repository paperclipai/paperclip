import { and, eq, inArray } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import type { IssueBlockerAttention } from "@paperclipai/shared";
import { issueService } from "./issues.js";

/**
 * Blocker state for task status glyphs on bounded summary surfaces (recent
 * tasks, search results, case work). Every view resolves the same glyph from
 * it (covered → "in queue"), so a blocked task never looks different in a
 * sidebar than in its detail pane.
 *
 * The blocker walk is company-scoped, so the result carries only what the
 * glyph needs: state, reason and counts. Blocker titles and IDs never leave
 * this helper. A sampled blocker identifier is kept only when the caller
 * confirms that the actor can read that blocker.
 */
export async function listIssueStatusBlockerAttention(
  db: Db,
  companyId: string,
  rows: ReadonlyArray<{ id: string; status: string }>,
  readableIssueIds?: (ids: string[]) => Promise<ReadonlySet<string>>,
): Promise<Map<string, IssueBlockerAttention>> {
  const blockedIds = [...new Set(rows.filter((row) => row.status === "blocked").map((row) => row.id))];
  if (blockedIds.length === 0) return new Map();
  const nodes = await db.select({
    id: issues.id,
    companyId: issues.companyId,
    parentId: issues.parentId,
    identifier: issues.identifier,
    title: issues.title,
    status: issues.status,
    executionRunId: issues.executionRunId,
    assigneeAgentId: issues.assigneeAgentId,
    assigneeUserId: issues.assigneeUserId,
  }).from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, blockedIds)));
  const attention = await issueService(db).listBlockerAttention(companyId, nodes);
  const sampledIds = [...new Set([...attention.values()].flatMap((item) => item.terminalBlocker ? [item.terminalBlocker.id] : []))];
  const readable = readableIssueIds && sampledIds.length > 0 ? await readableIssueIds(sampledIds) : new Set<string>();

  const result = new Map<string, IssueBlockerAttention>();
  for (const [issueId, item] of attention) {
    const sample = item.terminalBlocker;
    const readableSample = sample && readable.has(sample.id) ? (sample.identifier ?? sample.id) : null;
    result.set(issueId, {
      state: item.state,
      reason: item.reason,
      unresolvedBlockerCount: item.unresolvedBlockerCount,
      coveredBlockerCount: item.coveredBlockerCount,
      stalledBlockerCount: item.stalledBlockerCount,
      attentionBlockerCount: item.attentionBlockerCount,
      sampleBlockerIdentifier: readableSample && item.sampleBlockerIdentifier === readableSample ? readableSample : null,
      sampleStalledBlockerIdentifier: readableSample && item.sampleStalledBlockerIdentifier === readableSample ? readableSample : null,
    });
  }
  return result;
}
