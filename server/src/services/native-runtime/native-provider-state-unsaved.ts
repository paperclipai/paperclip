import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, nativeHarnessBackups, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { NATIVE_PROVIDER_STATE_INCOMPATIBLE, NATIVE_PROVIDER_STATE_UNSAVED_KEY } from "./native-session-resume.js";

const REASON = "harness_backup_not_saved";

type RunBinding = { companyId: string; issueId: string; runId: string };

/**
 * Mark the run's checkpoint not resumable, only when the run already holds an
 * accepted result and no current durable backup. A failure before acceptance,
 * or after the backup became current, changes nothing here. The run
 * status, result, and outcome are untouched.
 */
export async function markAcceptedRunProviderStateUnsaved(db: Db, binding: RunBinding): Promise<boolean> {
  const mark = { [NATIVE_PROVIDER_STATE_UNSAVED_KEY]: { code: NATIVE_PROVIDER_STATE_INCOMPATIBLE, reason: REASON, recordedAt: new Date().toISOString() } };
  const rows = await db.update(heartbeatRuns).set({
    runnerProfileJson: sql`(case when jsonb_typeof(${heartbeatRuns.runnerProfileJson}) = 'object' then ${heartbeatRuns.runnerProfileJson} else '{}'::jsonb end) || ${JSON.stringify(mark)}::jsonb`,
  }).where(and(
    eq(heartbeatRuns.id, binding.runId),
    eq(heartbeatRuns.companyId, binding.companyId),
    eq(heartbeatRuns.nativeIssueId, binding.issueId),
    sql`exists (select 1 from ${nativeRunFinalizations} inner join ${nativeRunResults}
      on ${nativeRunResults.id} = ${nativeRunFinalizations.resultId}
      and ${nativeRunResults.runId} = ${nativeRunFinalizations.runId}
      and ${nativeRunResults.companyId} = ${nativeRunFinalizations.companyId}
      and ${nativeRunResults.schemaStatus} = 'accepted'
      where ${nativeRunFinalizations.runId} = ${binding.runId}::uuid
        and ${nativeRunFinalizations.companyId} = ${binding.companyId}::uuid
        and ${nativeRunFinalizations.issueId} = ${binding.issueId}::uuid)`,
    // A failure after this run's durable backup became current (for example
    // scratch cleanup) leaves the backup restorable: keep the resume path.
    sql`not exists (select 1 from ${nativeHarnessBackups}
      where ${nativeHarnessBackups.companyId} = ${binding.companyId}::uuid
        and ${nativeHarnessBackups.runId} = ${binding.runId}::uuid
        and ${nativeHarnessBackups.status} = 'current')`,
  )).returning({ id: heartbeatRuns.id });
  return rows.length > 0;
}

/** A later save of the same run's provider state restores the resume path. */
export async function clearRunProviderStateUnsaved(db: Db, binding: RunBinding): Promise<void> {
  await db.update(heartbeatRuns).set({
    runnerProfileJson: sql`${heartbeatRuns.runnerProfileJson} - ${NATIVE_PROVIDER_STATE_UNSAVED_KEY}`,
  }).where(and(
    eq(heartbeatRuns.id, binding.runId),
    eq(heartbeatRuns.companyId, binding.companyId),
    eq(heartbeatRuns.nativeIssueId, binding.issueId),
    sql`${heartbeatRuns.runnerProfileJson} ? ${NATIVE_PROVIDER_STATE_UNSAVED_KEY}`,
  ));
}
