import { setTimeout as delay } from "node:timers/promises";
import { expect, type Response } from "@playwright/test";
import { pollUntil } from "./api.js";
import { sendChatMessage } from "./chat-flow.js";
import { captureLoadedContinuation } from "./continuation-screenshot.js";
import { createTaskThroughUi } from "./user-actions.js";
import { downloadIndexedHistory } from "./indexed-history-download.js";
import { enduranceMarker, enduranceOutput, endurancePrompt } from "./history-endurance-cases.js";
import { completeHistoryRestart, restartDuringHistoryTool, type ActiveHistoryRestart } from "./history-active-restart.js";
import { gradeHistoryEndurance, retainedHistoryReadFailure, type HistoryEnduranceRound } from "./history-endurance-scoring.js";
import { summarizeProviderTraceInspection } from "./history-provider-trace.js";
import type { runContinuationFlow } from "./continuation-flow.js";

type Row = Record<string, any>;

/** Repeated ordinary work, not a simulated provider or a held-open model call. */
export async function runHistoryEnduranceFlow(input: Parameters<typeof runContinuationFlow>[0]) {
  const { page, api, fixtures, execution } = input;
  const schedule = execution.task.historyEndurance;
  if (!schedule || process.env.PAPERCLIP_NATIVE_INDEXED_STATE !== "1") {
    throw new Error("History endurance requires a declared schedule and indexed state");
  }
  const observations: HistoryEnduranceRound[] = [];
  const completedRuns = new Set<string>();
  const logReadFailures: Array<{ runId: string; status: number }> = [];
  const inspectLogResponse = (response: Response) => {
    const failure = retainedHistoryReadFailure(response.url(), response.status(), completedRuns);
    if (failure && logReadFailures.length < 64) {
      // Keep only public fixture identities and status codes. Response bodies,
      // headers, query strings and private logs are not report evidence.
      logReadFailures.push(failure);
    }
  };
  page.on("response", inspectLogResponse);
  const runs = new Map<string, Row>();
  let issue: Row | undefined;
  let currentRunId: string | undefined;
  let checks: ReturnType<typeof gradeHistoryEndurance> = [];
  const open = () => page.goto(`/${fixtures.company.issuePrefix}/issues/${issue!.identifier ?? issue!.id}`, { waitUntil: "domcontentloaded" });
  const persist = async () => {
    checks = gradeHistoryEndurance({ ...schedule, nonce: input.nonce, observations, logReadFailures });
    if (issue) input.observe(issue, [...runs.values()], checks);
    await input.evidence("history-endurance.json", { schema: "paperclip.history-endurance.v1", schedule, observations, logReadFailures, checks });
    await input.evidence("api-state.json", { issue, runs: [...runs.values()], checkpoint: observations.at(-1), checks });
  };
  const readOutput = (run: Row, round: number) => downloadIndexedHistory({
    page, api, issuePrefix: fixtures.company.issuePrefix!,
    run: { id: run.id, agentId: run.agentId }, expected: enduranceOutput(input.nonce, round), requireCommandStream: true,
  });
  try {
    await api.patch("/api/instance/settings/experimental", { enableClassicTaskInterface: false });
    for (let round = 0; round < schedule.rounds; round++) {
      const previous = observations.at(-1);
      const due = previous ? previous.submittedAt + schedule.intervalMs : Date.now();
      // Do not leave a task page polling the server for hours between rounds.
      // Reopen its real route for every browser action and reviewed screenshot.
      if (Date.now() < due) await page.goto("about:blank");
      while (Date.now() < due) {
        if (Date.now() >= input.deadlineAt) throw new Error("History endurance deadline exceeded during idle interval");
        await delay(Math.min(30_000, due - Date.now()));
      }
      const restarted = round > 0 && round % schedule.restartEvery === 0;
      const restartMode = restarted ? (round / schedule.restartEvery % 2 === 0 ? "hard" : "graceful") : null;
      if (restartMode) await input.restart(restartMode);
      // Each model turn has a ten-minute deadline; a 72h schedule cannot hide a stuck turn.
      const submittedAt = Date.now();
      const deadlineAt = Math.min(input.deadlineAt, submittedAt + 10 * 60_000);
      const prior = new Set(runs.keys());
      const activeRestartRequested = schedule.activeRestartRound === round;
      let activeRestart: ActiveHistoryRestart | undefined;
      if (round === 0) {
        await createTaskThroughUi({ page, issuePrefix: fixtures.company.issuePrefix!, agentName: fixtures.agent.name,
          title: execution.task.buildTitle(input.nonce), prompt: endurancePrompt(input.nonce, round, activeRestartRequested), workMode: "standard" });
        issue = await pollUntil({ label: "history endurance task created", deadlineAt,
          load: async () => (await api.get<Row[]>(`/api/companies/${fixtures.company.id}/issues?limit=100`))
            .find(row => row.title === execution.task.buildTitle(input.nonce)), accept: Boolean });
        if (!issue) throw new Error("Missing history endurance task");
      } else {
        await open();
        await sendChatMessage(page, endurancePrompt(input.nonce, round, activeRestartRequested));
      }
      if (activeRestartRequested) {
        activeRestart = await restartDuringHistoryTool({ api, companyId: fixtures.company.id, agentId: fixtures.agent.id,
          issueId: issue!.id, prior, marker: enduranceMarker(input.nonce, round), deadlineAt, restart: input.restart });
        await input.evidence("active-restart.json", activeRestart);
      }
      let stable = "";
      await pollUntil({ label: `history endurance round ${round}`, deadlineAt, intervalMs: 1000,
        load: async () => {
          issue = await api.get<Row>(`/api/issues/${issue!.id}`);
          // Only recent rows are polled. Older observations belong to the fixed fixture,
          // and are not loaded anew as the task ages.
          const listed = await api.get<Row[]>(`/api/companies/${fixtures.company.id}/heartbeat-runs?agentId=${fixtures.agent.id}&limit=10`);
          for (const row of listed) {
            if (!prior.has(row.id) && row.agentId === fixtures.agent.id) currentRunId = row.id;
            if (runs.get(row.id)?.status === "succeeded") continue;
            const detail = await api.get<Row>(`/api/heartbeat-runs/${row.id}`);
            if (detail.contextSnapshot?.issueId !== issue!.id) throw new Error("Unexpected out-of-task provider run during history endurance");
            runs.set(row.id, detail);
          }
          input.observe(issue, [...runs.values()], checks);
          return { issue, current: [...runs.values()].filter(row => !prior.has(row.id)) };
        },
        accept: ({ issue: currentIssue, current }) => {
          const key = current.length === 1 && current[0]!.status === "succeeded" && currentIssue.status === "done" &&
            !currentIssue.scheduledRetry && !currentIssue.activeRecoveryAction ? current[0]!.id : "";
          const ready = !!key && key === stable; stable = key; return ready;
        },
        reject: ({ current }) => current.length > 1 ? "Unexpected extra provider run during history endurance" :
          current.some(row => ["failed", "timed_out", "cancelled"].includes(row.status)) ? "History endurance provider run failed" : undefined,
      });
      const run = [...runs.values()].find(row => !prior.has(row.id))!;
      const [documents, interactions, tasks] = await Promise.all([
        api.get<Row[]>(`/api/issues/${issue!.id}/documents`),
        api.get<Row[]>(`/api/issues/${issue!.id}/interactions`),
        api.get<Row[]>(`/api/companies/${fixtures.company.id}/issues?limit=100`),
      ]);
      const document = await api.get<HistoryEnduranceRound["document"]>(`/api/issues/${issue!.id}/documents/history-ledger`);
      const output = await readOutput(run, round);
      const originalOutput = round === 0 ? output : await readOutput(runs.get(observations[0]!.run.id)!, 0);
      if (activeRestart) {
        activeRestart = await completeHistoryRestart(api, activeRestart);
        await input.evidence("active-restart.json", activeRestart);
      }
      observations.push({ round, submittedAt, finishedAt: Date.now(), issueId: issue!.id, issueStatus: issue!.status,
        run: { id: run.id, status: run.status, runtimeMode: run.runtimeMode, sessionIdBefore: run.sessionIdBefore, sessionIdAfter: run.sessionIdAfter },
        document, documentCount: documents.length, pendingInteractions: interactions.filter(i => i.status === "pending").length,
        childCount: tasks.filter(t => t.parentId === issue!.id).length, restarted, restartMode, ...(activeRestart ? { activeRestart } : {}), output, originalOutput });
      completedRuns.add(run.id);
      await persist();
      expect(checks.filter(check => check.id !== "all-rounds" && !check.passed), "history endurance round oracle").toEqual([]);
      await open();
      await captureLoadedContinuation(page, String(issue!.title), () =>
        input.capture(`history-round-${round}`, `History endurance round ${round + 1}`, `history-round-${round}.png`));
    }
    await input.capture("final-state", "History retained through every continuation", "final-state.png");
  } catch (error) {
    const latestRunId = currentRunId ?? [...runs.values()].at(-1)?.id;
    let traceDiagnostic: Record<string, unknown>;
    if (!latestRunId) {
      traceDiagnostic = { capture: "missing", reason: "no_current_run_id", frameCount: 0, frames: [], omittedFrameCount: 0, truncated: false };
    } else {
      try {
        const response = await api.request.get(`/api/heartbeat-runs/${encodeURIComponent(latestRunId)}/provider-trace`);
        traceDiagnostic = response.ok()
          ? summarizeProviderTraceInspection({ httpStatus: response.status(), inspection: await response.json().catch(() => undefined) })
          : summarizeProviderTraceInspection({ httpStatus: response.status() });
      } catch {
        traceDiagnostic = { capture: "unavailable", reason: "inspection_request_failed" };
      }
    }
    try {
      await input.evidence("provider-trace-diagnostic.json", {
        schema: "paperclip.history-endurance.provider-trace-diagnostic.v1",
        runId: latestRunId ?? null,
        ...traceDiagnostic,
      });
    } catch {
      // Preserve the original flow failure; the evidence writer applies the
      // normal sanitizer and may itself be unavailable during a failed attempt.
    }
    throw error;
  } finally {
    page.off("response", inspectLogResponse);
    await persist();
  }
  expect(checks.filter(check => !check.passed), "complete history endurance oracle").toEqual([]);
  return { issue: issue!, runs: [...runs.values()], checks };
}
