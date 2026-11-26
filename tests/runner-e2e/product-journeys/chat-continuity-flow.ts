import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { sendChatMessage } from "../chat-flow.js";
import { readBoundTaskFinalReply } from "../native-task-reply.js";
import { collectRunEvents } from "../run-observations.js";
import { chatContinuityActivityComplete, chatContinuityIssueId, chatContinuityResetReceiptMatches,
  chatContinuityResetRun, chatContinuityScenario, gradeChatContinuity,
  type ChatContinuityPoint, type ChatContinuityScope, type ChatContinuityResetReceipt } from "./chat-continuity-evidence.js";
import { createObservedReader } from "./observation-read.js";
import { captureProductScreenshot } from "./product-screenshot.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

type Row = Record<string, any>;
interface Options { deadlineAt: number; directory: string }

export async function runChatContinuity(context: JourneyContext, session: TargetSession,
  campaignId: string, evidence: JourneyEvidence, options: Options) {
  const agent = context.agent;
  if (!agent || agent.runtimeMode !== "native" || !agent.model || !agent.provider || !context.environmentId) {
    throw new JourneyError("unsupported", "native_agent_and_environment_required");
  }
  const scope: ChatContinuityScope = { companyId: context.company.id, userId: context.user.id,
    agentId: agent.id, agentName: agent.name, environmentId: context.environmentId,
    provider: agent.provider, model: agent.model, campaignId };
  const scenario = chatContinuityScenario(campaignId), reader = createObservedReader(context.api, options.deadlineAt);
  const chatPath = `/api/companies/${scope.companyId}/chats/${agent.id}`;
  const chatUrl = `${context.api.origin}/${encodeURIComponent(context.company.issuePrefix)}/chats/${encodeURIComponent(agent.id)}`;
  const points: ChatContinuityPoint[] = [];
  let chatId: string | undefined, owned = false;
  const remaining = () => {
    const value = options.deadlineAt - Date.now();
    if (value <= 0) throw new JourneyError("failed", "chat_continuity_deadline");
    return value;
  };
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const retain = async () => writeFile(path.join(options.directory, "chat-continuity.json"),
    JSON.stringify({ scope, points, checks: gradeChatContinuity(scope, points) }, null, 2), { mode: 0o600 });
  const freshChat = { companyId: scope.companyId, userId: scope.userId, leadAgentId: agent.id, absent: true as const };
  const read = async (): Promise<Omit<ChatContinuityPoint, "phase"> | undefined> => {
    const chat = await reader.get<Row | null>(chatPath);
    if (!chat) return;
    if (!chat.id || chat.companyId !== scope.companyId || chat.assigneeAgentId !== agent.id
      || chat.conversationAgentId !== agent.id || chat.conversationUserId !== scope.userId
      || chat.createdByUserId !== scope.userId || chat.title !== `Chat with ${agent.name}` || chatId && chat.id !== chatId) {
      throw new JourneyError("failed", "chat_continuity_scope_mismatch");
    }
    chatId ??= chat.id;
    if (!owned) {
      await session.own({ kind: "issue", name: chat.title, id: chat.id, journeyId: "chat-continuity", freshChat });
      owned = true;
    }
    const [summaries, comments, tasks, activity] = await Promise.all([
      reader.get<Row[]>(`/api/issues/${chat.id}/runs`), reader.get<Row[]>(`/api/issues/${chat.id}/comments?order=asc`),
      reader.get<Row[]>(`/api/companies/${scope.companyId}/issues?view=index&assigneeAgentId=${agent.id}&includeAgentCreatedTasks=true&limit=2`),
      reader.get<Row[]>(`/api/companies/${scope.companyId}/activity?agentId=${agent.id}&limit=500`),
    ]);
    if (![summaries, comments, tasks, activity].every(Array.isArray) || summaries.length > 4 || !chatContinuityActivityComplete(scope, activity)
      || new Set(summaries.map(row => row.runId)).size !== summaries.length) {
      throw new JourneyError("failed", "chat_continuity_observation_incomplete");
    }
    const runs = await Promise.all(summaries.map(async row => {
      if (typeof row.runId !== "string" || !row.runId) throw new JourneyError("failed", "chat_continuity_run_mismatch");
      if (row.agentId !== agent.id || row.contextIssueId !== chat.id) throw new JourneyError("failed", "chat_continuity_summary_scope_mismatch");
      const run = await reader.get<Row>(`/api/heartbeat-runs/${row.runId}`);
      if (run.id !== row.runId || run.companyId !== scope.companyId || run.agentId !== agent.id
        || chatContinuityIssueId(run) !== chat.id || !["queued", "running", "succeeded"].includes(run.status)) {
        throw new JourneyError("failed", "chat_continuity_run_mismatch");
      }
      return run;
    }));
    const resetReceipts: ChatContinuityResetReceipt[] = summaries.flatMap(summary => summary.resultJson?.conversationReset === true ? [{
      source: "issue-runs" as const, companyId: scope.companyId, issueId: chat.id,
      runId: summary.runId, agentId: summary.agentId, status: summary.status,
      contextIssueId: summary.contextIssueId, wakeCommentId: summary.wakeCommentId, resultJson: { conversationReset: true as const },
    }] : []);
    return { chat, runs, comments, tasks, activity, resetReceipts };
  };
  const wait = async (providerCount: number, resetCount: number) => {
    let stable = "";
    while (remaining() > 0) {
      const state = await read();
      if (state) {
        const providerRuns = state.runs.filter(run => !chatContinuityResetRun(run));
        const resetRuns = state.runs.filter(chatContinuityResetRun);
        if (providerRuns.length > providerCount || resetRuns.length > resetCount) throw new JourneyError("failed", "chat_continuity_extra_run");
        const ready = providerRuns.length === providerCount && resetRuns.length === resetCount
          && state.runs.every(run => run.status === "succeeded")
          && providerRuns.every(run => run.nativePhase === "committed")
          && resetRuns.every(run => state.resetReceipts.filter(receipt => chatContinuityResetReceiptMatches(scope, state.chat.id, run, receipt)).length === 1)
          && state.chat.status === "in_review" && state.chat.conversationState === "waiting"
          && !state.chat.executionRunId && !state.chat.scheduledRetry && !state.chat.activeRecoveryAction;
        const key = ready ? JSON.stringify([state.chat.id, state.chat.conversationSessionGeneration,
          state.runs.map(run => [run.id, run.status]), state.comments.map(row => row.id)]) : "";
        if (key && stable === key) return state;
        stable = key;
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, remaining())));
    }
    throw new JourneyError("failed", "chat_continuity_not_settled");
  };
  const snapshot = async (phase: ChatContinuityPoint["phase"], state: Awaited<ReturnType<typeof wait>>, runId?: string) => {
    let point: ChatContinuityPoint = { phase, ...state };
    if (runId) {
      const load = async () => {
        const latest = await read();
        const run = latest?.runs.find(run => run.id === runId);
        if (!latest || !run) throw new JourneyError("failed", "chat_continuity_reply_run_missing");
        const events = await collectRunEvents<Row>((afterSeq, limit) =>
          reader.get(`/api/heartbeat-runs/${runId}/events?afterSeq=${afterSeq}&limit=${limit}`));
        return { run, comments: latest.comments, events };
      };
      const reply = await readBoundTaskFinalReply({ page: context.page, runId, agentId: agent.id,
        deadlineAt: options.deadlineAt, knownCompanyPrefixes: [context.company.issuePrefix], load });
      const latest = await read(), runEvidence = await load();
      if (!latest) throw new JourneyError("failed", "chat_continuity_reply_chat_missing");
      point = { phase, ...latest, reply, events: runEvidence.events };
    }
    points.push(point);
    await retain();
    await captureProductScreenshot(context.page, context.api.origin, path.join(options.directory, `chat-${phase}.png`), options.deadlineAt);
    return point;
  };
  const newProviderRun = (state: Awaited<ReturnType<typeof wait>>, old: Row[] = []) => {
    const added = state.runs.filter(run => !chatContinuityResetRun(run) && !old.some(before => before.id === run.id));
    if (added.length !== 1) throw new JourneyError("failed", "chat_continuity_turn_ambiguous");
    return added[0]!;
  };
  try {
    const settings = await reader.get<Row>("/api/instance/settings/experimental");
    if (settings.enableAgentChat !== true) throw new JourneyError("unsupported", "agent_chat_required");
    const history = await reader.get<Row[]>(`/api/companies/${scope.companyId}/heartbeat-runs?agentId=${agent.id}&limit=1&summary=true`);
    if (!Array.isArray(history) || history.some(run => !run || run.companyId !== scope.companyId || run.agentId !== agent.id)) {
      throw new JourneyError("failed", "chat_continuity_agent_history_scope_mismatch");
    }
    if (history.length) throw new JourneyError("unsupported", "fresh_chat_agent_required");
    scope.agentHistory = { source: "company-agent-runs", companyId: scope.companyId, agentId: agent.id, limit: 1, runIds: [], observedBeforeSend: true };
    if (await reader.get(chatPath) !== null) throw new JourneyError("unsupported", "fresh_agent_chat_required");
    await session.own({ kind: "issue", name: `Chat with ${agent.name}`, journeyId: "chat-continuity", freshChat });
    await context.page.goto(chatUrl, { waitUntil: "domcontentloaded", timeout: remaining() });
    await expect(context.page.getByTestId("task-chat-composer-input")).toBeVisible({ timeout: remaining() });
    await sendChatMessage(context.page, scenario.remember);
    const first = await wait(1, 0), initial = await snapshot("initial", first, newProviderRun(first).id);
    await context.page.goto(`${context.api.origin}/${encodeURIComponent(context.company.issuePrefix)}/issues`, { waitUntil: "domcontentloaded", timeout: remaining() });
    await context.page.goto(chatUrl, { waitUntil: "domcontentloaded", timeout: remaining() });
    await context.page.reload({ waitUntil: "domcontentloaded", timeout: remaining() });
    await expect(context.page.getByTestId("task-chat-composer-input")).toBeVisible({ timeout: remaining() });
    await snapshot("returned", await wait(1, 0), initial.reply!.runId);
    await sendChatMessage(context.page, scenario.recall);
    const second = await wait(2, 0), recalled = await snapshot("recalled", second, newProviderRun(second, initial.runs).id);
    await sendChatMessage(context.page, scenario.reset);
    await snapshot("reset", await wait(2, 1));
    await sendChatMessage(context.page, scenario.fresh);
    const third = await wait(3, 1), freshRun = newProviderRun(third, recalled.runs);
    await snapshot("fresh", third, freshRun.id);
    await context.page.goto(chatUrl, { waitUntil: "domcontentloaded", timeout: remaining() });
    await snapshot("reopened", await wait(3, 1), freshRun.id);
  } finally {
    evidence.checks.push(...gradeChatContinuity(scope, points));
    await retain();
    await reader.preserve(options.directory);
  }
  if (evidence.checks.some(check => !check.passed)) throw new JourneyError("failed", "chat_continuity_evidence_failed");
}
