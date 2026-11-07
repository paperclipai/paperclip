import { heartbeatRuns, type Db } from "@paperclipai/db";
import { and, eq, getTableColumns, sql } from "drizzle-orm";

type Run = typeof heartbeatRuns.$inferSelect;
export type ReleaseRun = Omit<Run, "runnerProfileJson" | "stdoutExcerpt" | "stderrExcerpt">;

export async function readReleaseRun(db: Db, scope: { companyId: string; runId: string }) {
  const [selected] = await db.select({
    ...getTableColumns(heartbeatRuns),
    contextSnapshot: sql<Run["contextSnapshot"]>`case when ${heartbeatRuns.runtimeMode} = 'native'
      and jsonb_typeof(${heartbeatRuns.contextSnapshot}) = 'object'
      then ${heartbeatRuns.contextSnapshot} - array['executionContinuation', 'paperclipWake', 'paperclipWakeComment',
        'paperclipTaskMarkdown', 'paperclipTaskMarkdownCompact', 'paperclipTaskMarkdownAssignment',
        'paperclipTaskMarkdownAssignmentCompact', 'paperclipWorkspace', 'paperclipEnvironment',
        'paperclipContinuationSummary']
      else ${heartbeatRuns.contextSnapshot} end`,
    runnerProfileJson: sql<Run["runnerProfileJson"]>`case when ${heartbeatRuns.runtimeMode} = 'native'
      then null else ${heartbeatRuns.runnerProfileJson} end`,
    stdoutExcerpt: sql<Run["stdoutExcerpt"]>`case when ${heartbeatRuns.runtimeMode} = 'native'
      then null else ${heartbeatRuns.stdoutExcerpt} end`,
    stderrExcerpt: sql<Run["stderrExcerpt"]>`case when ${heartbeatRuns.runtimeMode} = 'native'
      then null else ${heartbeatRuns.stderrExcerpt} end`,
    resultJson: sql<Run["resultJson"]>`case when jsonb_typeof(${heartbeatRuns.resultJson}) = 'object'
      then ${heartbeatRuns.resultJson} - 'stdout' - 'stderr' else ${heartbeatRuns.resultJson} end`,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, scope.runId), eq(heartbeatRuns.companyId, scope.companyId)));
  if (!selected || selected.runtimeMode !== "native") return { kind: "complete" as const, run: selected };
  const { runnerProfileJson: _profile, stdoutExcerpt: _stdout, stderrExcerpt: _stderr, ...run } = selected;
  return { kind: "native" as const, run };
}
