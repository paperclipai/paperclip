import { pollUntil, type RunnerApi } from "./api.js";

type Row = Record<string, any>;
export interface ActiveHistoryRestart {
  runId: string;
  executionId: string;
  sourceInstanceId: string;
  normalizedSessionId: string;
  startedEventId: string;
  startedSeq: number;
  startedAt: number;
  restartStartedAt: number;
  restartFinishedAt: number;
  completedEventId?: string;
  completedSeq?: number;
  completedAt?: number;
  exitCode?: number;
}

export function historyToolEvent(row: Row, runId: string): Row | null {
  const event = row.payload?.prpEvent, body = event?.payload;
  return event?.runId === runId && event.sourceKind === "runner" &&
    typeof event.sourceInstanceId === "string" && typeof event.normalizedSessionId === "string" &&
    typeof event.sourceEventId === "string" && Number.isSafeInteger(event.sourceSeq) && event.sourceSeq > 0 &&
    body?.schema === "paperclip.tool.execution.v1" && body.transport === "process" &&
    typeof body.executionId === "string" && typeof body.name === "string" ? event : null;
}

/** Crash only the test supervisor's controller after public events show the
 * requested shell command is running. No provider PID or private database hook. */
export async function restartDuringHistoryTool(input: {
  api: RunnerApi; companyId: string; agentId: string; issueId: string; prior: Set<string>;
  marker: string; deadlineAt: number; restart(mode: "hard"): Promise<void>;
}): Promise<ActiveHistoryRestart> {
  let runId = "", after = 0, started: Row | undefined, completed = false;
  const active = await pollUntil({ label: "history diagnostic running before controller crash", deadlineAt: input.deadlineAt, intervalMs: 200,
    load: async () => {
      const rows = (await input.api.get<Row[]>(`/api/companies/${input.companyId}/heartbeat-runs?agentId=${input.agentId}&limit=10`)).filter(row => !input.prior.has(row.id));
      if (rows.length > 1) throw new Error("Unexpected extra run before active history restart");
      if (!rows[0]) return null;
      const run = await input.api.get<Row>(`/api/heartbeat-runs/${rows[0].id}`);
      if (run.contextSnapshot?.issueId !== input.issueId || (runId && runId !== run.id)) throw new Error("Active history restart run binding changed");
      runId = run.id;
      const events = await input.api.get<Row[]>(`/api/heartbeat-runs/${runId}/events?afterSeq=${after}&limit=200`);
      for (const row of events) {
        after = Math.max(after, row.seq);
        const event = historyToolEvent(row, runId);
        if (!event) continue;
        if (event.eventType === "tool.execution.started" && event.payload.status === "running" &&
          event.payload.name.includes(input.marker) && /\bsleep\s+45\b/.test(event.payload.name)) started = event;
        if (started && event.eventType === "tool.execution.completed" && event.payload.executionId === started.payload.executionId) completed = true;
      }
      return { run, started, completed };
    },
    accept: state => !!state?.started && !state.completed && state.run.status === "running",
    reject: state => state?.completed || (state && ["succeeded", "failed", "timed_out", "cancelled"].includes(state.run.status)) ? "Requested crash boundary already passed" : undefined,
  });
  const event = active!.started!;
  const evidence: ActiveHistoryRestart = { runId, executionId: event.payload.executionId,
    sourceInstanceId: event.sourceInstanceId, normalizedSessionId: event.normalizedSessionId,
    startedEventId: event.sourceEventId, startedSeq: event.sourceSeq, startedAt: Date.parse(event.emittedAt),
    restartStartedAt: Date.now(), restartFinishedAt: 0 };
  await input.restart("hard");
  evidence.restartFinishedAt = Date.now();
  return evidence;
}

export async function completeHistoryRestart(api: RunnerApi, evidence: ActiveHistoryRestart): Promise<ActiveHistoryRestart> {
  let after = 0;
  for (let page = 0; page < 32; page++) {
    const rows = await api.get<Row[]>(`/api/heartbeat-runs/${evidence.runId}/events?afterSeq=${after}&limit=200`);
    for (const row of rows) {
      const event = historyToolEvent(row, evidence.runId);
      if (event?.eventType === "tool.execution.completed" && event.payload.executionId === evidence.executionId &&
        event.sourceInstanceId === evidence.sourceInstanceId && event.normalizedSessionId === evidence.normalizedSessionId) {
        return { ...evidence, completedEventId: event.sourceEventId, completedSeq: event.sourceSeq,
          completedAt: Date.parse(event.emittedAt), exitCode: event.payload.exitCode };
      }
    }
    if (!rows.length) break;
    if (!(rows.at(-1)!.seq > after)) throw new Error("Active history event cursor did not advance");
    after = rows.at(-1)!.seq;
  }
  throw new Error("The exact active tool did not complete after controller restart");
}

export function validActiveHistoryRestart(evidence: ActiveHistoryRestart | undefined, runId: string): boolean {
  return !!evidence && evidence.runId === runId && !!evidence.executionId && !!evidence.sourceInstanceId && !!evidence.normalizedSessionId &&
    !!evidence.startedEventId && !!evidence.completedEventId && evidence.completedEventId !== evidence.startedEventId &&
    Number.isSafeInteger(evidence.startedSeq) && evidence.startedSeq > 0 && Number.isSafeInteger(evidence.completedSeq) && evidence.completedSeq! > evidence.startedSeq &&
    Number.isFinite(evidence.startedAt) && evidence.startedAt <= evidence.restartStartedAt &&
    evidence.restartFinishedAt >= evidence.restartStartedAt && Number.isFinite(evidence.completedAt) &&
    evidence.completedAt! > evidence.restartStartedAt && evidence.exitCode === 0;
}
