import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, nativeRunResults,
  nativeRunnerCheckpoints, type Db } from "@paperclipai/db";
import { nativeSessionProviderEvidence } from "./native-session-resume.js";
import { hasWorkspaceRestoreFailure } from "@paperclipai/shared";

export async function stoppedLegacyNativeBootstrapRunIds(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; runIds: string[];
}): Promise<Set<string>> {
  if (!input.runIds.length) return new Set();
  const rows = await db.select({ run: heartbeatRuns, finalization: nativeRunFinalizations }).from(heartbeatRuns)
    .innerJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId),
      eq(nativeRunFinalizations.runId, heartbeatRuns.id), eq(nativeRunFinalizations.issueId, input.issueId)))
    .where(and(eq(heartbeatRuns.companyId, input.companyId), inArray(heartbeatRuns.id, input.runIds),
      eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "failed"),
      sql`${nativeRunFinalizations.failureDetail}->'providerSessionEstablished' = 'false'::jsonb
        and ${nativeRunFinalizations.failureDetail}->'providerEventsExist' = 'false'::jsonb
        and ${nativeRunFinalizations.failureDetail}->'checkpointExists' = 'false'::jsonb`,
      eq(nativeRunFinalizations.phase, "terminal_failure"), isNull(nativeRunFinalizations.resultId),
      isNull(nativeRunFinalizations.leaseOwner), isNull(heartbeatRuns.processPid), isNull(heartbeatRuns.processGroupId),
      sql`not exists (select 1 from ${nativeRunnerCheckpoints} where ${nativeRunnerCheckpoints.companyId} = ${heartbeatRuns.companyId}
        and ${nativeRunnerCheckpoints.runId} = ${heartbeatRuns.id})`,
      sql`not exists (select 1 from ${nativeRunResults} where ${nativeRunResults.companyId} = ${heartbeatRuns.companyId}
        and ${nativeRunResults.runId} = ${heartbeatRuns.id})`,
      sql`not exists (select 1 from ${environmentLeases} where ${environmentLeases.companyId} = ${heartbeatRuns.companyId}
        and ${environmentLeases.heartbeatRunId} = ${heartbeatRuns.id} and ${environmentLeases.provider} <> 'local')`,
      sql`(select ${heartbeatRunEvents.eventType} = 'native.local_process_stopped'
          and ${heartbeatRunEvents.payload}->>'basis' = 'unidentified_runner_absent'
        from ${heartbeatRunEvents} where ${heartbeatRunEvents.companyId} = ${heartbeatRuns.companyId}
          and ${heartbeatRunEvents.runId} = ${heartbeatRuns.id} and ${heartbeatRunEvents.sourceEventId} is null
          and ${heartbeatRunEvents.eventType} in ('native.process_start_requested', 'native.process_identity_recorded', 'native.local_process_stopped')
        order by ${heartbeatRunEvents.seq} desc limit 1)`,
    ));
  const candidates = rows.filter(({ run, finalization }) => {
    const failure = finalization.failureDetail;
    return run.finishedAt !== null && run.resultJson?.executionRecovery == null
      && failure?.providerSessionEstablished === false && failure.providerEventsExist === false && failure.checkpointExists === false
      && !hasWorkspaceRestoreFailure(run.resultJson) && run.runnerProfileJson?.sessionCheckpoint == null
      && run.runnerProfileJson?.nativeControllerRecovery == null && run.runnerProfileJson?.nativeWorkspaceSync == null
      && run.runnerProfileJson?.nativeWorkspaceFinalizationOwner == null;
  }).map(({ run }) => run.id);
  const providerEvidence = await nativeSessionProviderEvidence(db, candidates);
  return new Set(candidates.filter(id => !providerEvidence.has(id)));
}
