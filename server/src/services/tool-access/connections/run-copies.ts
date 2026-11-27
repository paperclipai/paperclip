import { and, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import {
  decisionTrainingExamples,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueDocuments,
  nativeRunResults,
  type Db,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import { settledRunSql } from "./content-deletion.js";
import { RUN_CONTENT_DELETED_MARKER } from "./run-session-reset.js";
import { withoutFreeText } from "./content-cleaning.js";

export async function forgetRunInTrainingExamples(tx: Db, companyId: string, run: { id: string; changed: boolean }) {
  const runs = sql`${decisionTrainingExamples.snapshot}->'runs'`;
  const replaced = await tx
    .update(decisionTrainingExamples)
    .set({
      snapshot: sql`jsonb_set(${decisionTrainingExamples.snapshot}, '{runs}', (
        select coalesce(jsonb_agg(case when entry->>'id' = ${run.id}
          then jsonb_build_object('id', entry->'id', 'agentId', entry->'agentId', 'status', entry->'status',
            'startedAt', entry->'startedAt', 'finishedAt', entry->'finishedAt', 'contentDeleted', true)
          else entry end order by position), '[]'::jsonb)
        from jsonb_array_elements(${runs}) with ordinality as snapshot_runs(entry, position)))` as never,
    })
    .where(and(
      eq(decisionTrainingExamples.companyId, companyId),
      sql`jsonb_typeof(${runs}) = 'array'`,
      sql`${runs} @> jsonb_build_array(jsonb_build_object('id', ${run.id}::text))`,
      sql`not ${runs} @> jsonb_build_array(jsonb_build_object('id', ${run.id}::text, 'contentDeleted', true))`,
    ))
    .returning({ id: decisionTrainingExamples.id });
  if (replaced.length > 0) run.changed = true;
}

export async function forgetRunCopies(tx: Db, companyId: string, run: { id: string; changed: boolean }, row: { issueId: string | null; createdAt: Date }) {
  const results = await tx
    .select({ id: nativeRunResults.id, resultJson: nativeRunResults.resultJson })
    .from(nativeRunResults)
    .where(and(eq(nativeRunResults.companyId, companyId), eq(nativeRunResults.runId, run.id)));
  for (const result of results) {
    if (result.resultJson && typeof result.resultJson === "object" && RUN_CONTENT_DELETED_MARKER in result.resultJson) continue;
    const cleaned = withoutFreeText(result.resultJson) as Record<string, unknown>;
    await tx.update(nativeRunResults)
      .set({ resultJson: { ...cleaned, [RUN_CONTENT_DELETED_MARKER]: new Date().toISOString() } })
      .where(eq(nativeRunResults.id, result.id));
    run.changed = true;
  }
  const summaries = await tx
    .update(documentRevisions)
    .set({ body: "" })
    .where(and(
      eq(documentRevisions.companyId, companyId),
      eq(documentRevisions.createdByRunId, run.id),
      sql`${documentRevisions.body} <> ''`,
      sql`${documentRevisions.documentId} in (select ${issueDocuments.documentId} from ${issueDocuments}
        where ${issueDocuments.companyId} = ${companyId} and ${issueDocuments.key} = ${ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY})`,
    ))
    .returning({ id: documentRevisions.id, documentId: documentRevisions.documentId });
  if (summaries.length > 0) {
    run.changed = true;
    await tx
      .update(documents)
      .set({ latestBody: "" })
      .where(and(
        eq(documents.companyId, companyId),
        inArray(documents.id, summaries.map((summary) => summary.documentId)),
        inArray(documents.latestRevisionId, summaries.map((summary) => summary.id)),
      ));
  }
  if (!row.issueId) return;
  const handoffs = await tx
    .update(heartbeatRuns)
    .set({ contextSnapshot: sql`${heartbeatRuns.contextSnapshot} - 'paperclipSessionHandoffMarkdown'` as never })
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.issueId, row.issueId),
      gt(heartbeatRuns.createdAt, row.createdAt),
      sql`${heartbeatRuns.contextSnapshot} ? 'paperclipSessionHandoffMarkdown'`,
      settledRunSql(sql`${heartbeatRuns.id}`),
    ))
    .returning({ id: heartbeatRuns.id });
  if (handoffs.length > 0) run.changed = true;
}


export function runCopiesRemainSql(run: { id: SQL; companyId: SQL; issueId: SQL; error: SQL }): SQL {
  const entry = sql`jsonb_build_array(jsonb_build_object('id', ${run.id}::text))`;
  return sql`(${run.error} is not null
    or exists (select 1 from native_run_results n where n.company_id = ${run.companyId} and n.run_id = ${run.id}
      and not n.result_json ? ${RUN_CONTENT_DELETED_MARKER})
    or exists (select 1 from document_revisions r join issue_documents d on d.document_id = r.document_id
      where r.company_id = ${run.companyId} and r.created_by_run_id = ${run.id} and r.body <> ''
        and d.key = ${ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY})
    or exists (select 1 from decision_training_examples e where e.issue_id = ${run.issueId} and e.company_id = ${run.companyId}
      and jsonb_typeof(e.snapshot->'runs') = 'array' and e.snapshot->'runs' @> ${entry}
      and not e.snapshot->'runs' @> jsonb_build_array(jsonb_build_object('id', ${run.id}::text, 'contentDeleted', true))))`;
}

export async function forgetHandoffAfterDeletedRuns(db: Db, run: { id: string; companyId: string; issueId: string | null; createdAt: Date }) {
  if (!run.issueId) return false;
  const cleared = await db
    .update(heartbeatRuns)
    .set({ contextSnapshot: sql`${heartbeatRuns.contextSnapshot} - 'paperclipSessionHandoffMarkdown'` as never })
    .where(and(
      eq(heartbeatRuns.id, run.id),
      eq(heartbeatRuns.companyId, run.companyId),
      sql`${heartbeatRuns.contextSnapshot} ? 'paperclipSessionHandoffMarkdown'`,
      sql`exists (select 1 from heartbeat_runs earlier where earlier.company_id = ${run.companyId} and earlier.issue_id = ${run.issueId}
        and earlier.created_at < ${run.createdAt.toISOString()}::timestamptz and earlier.result_json ? ${RUN_CONTENT_DELETED_MARKER})`,
    ))
    .returning({ id: heartbeatRuns.id });
  return cleared.length > 0;
}
