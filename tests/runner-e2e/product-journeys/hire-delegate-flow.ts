import { mkdir, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { buildAgentMentionHref, buildProjectMentionHref, parseAgentMentionHref, parseProjectMentionHref } from "../../../packages/shared/src/project-mentions.js";
import { sendChatMessage, readChatOutputDocument, type ChatIssue, type ChatRun } from "../chat-flow.js";
import { assertChatHire, mutableIssueSnapshot } from "../chat-hardening.js";
import { ConnectionFailure } from "../connection-config.js";
import { assertHireAuditCoverage, assertHireBinding, assertHireDocument, assertHireRuns, assertHireTaskCreation, hireDelegateNames, hireResultLinkMatches, hireRunIssueId, observedHireResources, readHireConnectionChoice, type HireScope } from "./hire-delegate-evidence.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";
import { sendHireHandoffMessage } from "./hire-delegate-composer.js";

type Row = Record<string, any>;
type Agent = Parameters<typeof assertChatHire>[0]["agents"][number] & Row;
type Task = ChatIssue & Row;
type Run = ChatRun & Row;
interface Options { deadlineAt: number; directory: string; capture(id: string, label: string, file: string): Promise<void> }
class HireReadTransportError extends Error {}

export function hireHandoffMentions(scope: Pick<HireScope, "companyId" | "leadId" | "projectId" | "campaignId">, hiredId: string, hired: Row, project: Row) {
  if (![scope?.companyId, scope?.leadId, scope?.projectId, scope?.campaignId].every(value => typeof value === "string" && value.length > 0)) {
    throw new JourneyError("failed", "hire_handoff_context_unverified");
  }
  const names = hireDelegateNames(scope.campaignId);
  if (!hired || !project || typeof hiredId !== "string" || !hiredId || hired.id !== hiredId || hired.id === scope.leadId
    || hired.companyId !== scope.companyId || hired.reportsTo !== scope.leadId || hired.name !== names.hire
    || typeof project.id !== "string" || !project.id || project.id !== scope.projectId
    || project.companyId !== scope.companyId || project.name !== names.project) {
    throw new JourneyError("failed", "hire_handoff_context_unverified");
  }
  const agentHref = buildAgentMentionHref(hiredId, hired.icon ?? null), projectHref = buildProjectMentionHref(project.id, project.color ?? null);
  if (parseAgentMentionHref(agentHref)?.agentId !== hiredId || parseProjectMentionHref(projectHref)?.projectId !== project.id) {
    throw new JourneyError("failed", "hire_handoff_context_unverified");
  }
  return Object.freeze({ teammate: `[@${hired.name}](${agentHref})`, project: `[@${project.name}](${projectHref})` });
}

export async function hireDelegateReuse(context: JourneyContext, session: TargetSession, campaignId: string, evidence: JourneyEvidence, options: Options) {
  const { api, page } = context, agent = context.agent;
  if (!agent || agent.runtimeMode !== "native" || !context.environmentId) throw new JourneyError("unsupported", "native_agent_and_environment_required");
  const features = await api.get<Row>("/api/instance/settings/experimental");
  if (features.enableAgentChat !== true) throw new JourneyError("unsupported", "agent_chat_required");
  const company = await api.get<Row>(`/api/companies/${context.company.id}`);
  if (company.requireBoardApprovalForNewAgents !== false) throw new JourneyError("unsupported", "automatic_hiring_policy_required");
  const lead = await api.get<Row>(`/api/agents/${agent.id}`), names = hireDelegateNames(campaignId);
  if (lead.id !== agent.id || lead.companyId !== context.company.id || lead.permissions?.canCreateAgents !== true || !lead.runtimeConfig?.aiConnection) {
    throw new JourneyError("unsupported", "owned_hiring_agent_required");
  }
  const connectionChoice = await readHireConnectionChoice(api, { companyId: context.company.id,
    responsibleUserId: context.user.id, binding: lead.runtimeConfig.aiConnection });
  const check = (id: string, passed = true) => { evidence.checks.push({ id, passed }); if (!passed) throw new JourneyError("failed", id.replaceAll("-", "_")); };
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const retain = (name: string, value: unknown) => writeFile(path.join(options.directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
  await session.own({ kind: "project", name: names.project, journeyId: "hire-delegate-reuse" });
  const project = await api.post<Row>(`/api/companies/${context.company.id}/projects`, { name: names.project, description: "Disposable native hiring and delegation verification." });
  if (project.companyId !== context.company.id || !project.id || project.name !== names.project) throw new JourneyError("failed", "hire_project_binding_mismatch");
  await session.own({ kind: "project", name: names.project, id: project.id, journeyId: "hire-delegate-reuse" });
  const chatPath = `/api/companies/${context.company.id}/chats/${agent.id}`;
  if (await api.get(chatPath)) throw new JourneyError("unsupported", "fresh_lead_chat_required");
  const freshChat = { companyId: context.company.id, userId: context.user.id, leadAgentId: agent.id, absent: true as const };
  await session.own({ kind: "issue", name: `Chat with ${lead.name}`, journeyId: "hire-delegate-reuse", freshChat });
  const chatUrl = `${api.origin}/${context.company.issuePrefix}/chats/${agent.id}`;
  await page.goto(chatUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
  let scope: HireScope | undefined, hiredId: string | undefined;
  let hiredConnectionBinding: unknown;
  const known = new Set<string>();
  const taskNames = [names.checklist, names.review];
  const readObserved = async <T>(route: string): Promise<T> => {
    try { return await api.get<T>(route); }
    catch (error) {
      if (error instanceof ConnectionFailure && (error.message === "api_request_failed"
        || /^api_status_(408|429|502|503|504)$/.test(error.message))) {
        throw new HireReadTransportError("hire_observation_transport_unavailable");
      }
      throw error;
    }
  };
  const readRuns = async (issueId: string) => {
    const summaries = await readObserved<Row[]>(`/api/issues/${issueId}/runs`);
    if (!Array.isArray(summaries) || summaries.length > 7) throw new JourneyError("failed", "hire_run_limit_mismatch");
    return Promise.all(summaries.map(async row => {
      if (typeof row.runId !== "string" || !row.runId) throw new JourneyError("failed", "hire_run_scope_mismatch");
      const run = await readObserved<Run>(`/api/heartbeat-runs/${row.runId}`);
      if (run.id !== row.runId) throw new JourneyError("failed", "hire_run_scope_mismatch");
      return run;
    }));
  };
  const observe = async () => {
    const chat = await readObserved<Row | null>(chatPath);
    if (!chat) return undefined;
    if (chat.companyId !== context.company.id || chat.assigneeAgentId !== agent.id
      || chat.conversationAgentId !== agent.id || chat.conversationUserId !== context.user.id || chat.createdByUserId !== context.user.id) throw new JourneyError("failed", "hire_chat_scope_mismatch");
    scope ??= { companyId: context.company.id, leadId: agent.id, chatId: chat.id, projectId: project.id, campaignId,
      model: agent.model, provider: agent.provider, environmentId: context.environmentId!, connectionBinding: lead.runtimeConfig.aiConnection, connectionChoice,
      origin: api.origin, issuePrefix: context.company.issuePrefix };
    if (chat.id !== scope.chatId) throw new JourneyError("failed", "hire_chat_replaced");
    if (!known.has(chat.id)) { await session.own({ kind: "issue", name: chat.title, id: chat.id, journeyId: "hire-delegate-reuse", freshChat }); known.add(chat.id); }
    const leadProjection = await readRuns(chat.id);
    const leadRuns = leadProjection.filter(run => run.companyId === scope!.companyId
      && run.agentId === scope!.leadId && hireRunIssueId(run) === chat.id);
    const activity = await readObserved<Row[]>(`/api/companies/${context.company.id}/activity?agentId=${agent.id}&limit=500`);
    assertHireAuditCoverage(activity, leadRuns);
    const agents: Agent[] = [], tasks: Task[] = [], seen = new Set<string>();
    let scopeMismatch = false;
    for (const event of activity) {
      if (event.companyId !== scope.companyId || event.actorType !== "agent" || event.actorId !== agent.id || event.agentId !== agent.id
        || !leadRuns.some(run => run.id === event.runId && run.companyId === scope!.companyId && run.agentId === agent.id
          && hireRunIssueId(run) === chat.id && run.runtimeMode === "native")) continue;
      const kind = ["agent.hire_created", "agent.created"].includes(event.action) ? "agent"
        : ["issue.created", "issue.child_created"].includes(event.action) ? "issue" : undefined;
      if (!kind || event.entityType !== kind) continue;
      if (typeof event.entityId !== "string" || !event.entityId) throw new JourneyError("failed", "hire_resource_scope_mismatch");
      const key = `${kind}:${event.entityId}`;
      if (seen.has(key)) continue;
      if (seen.size >= 50) throw new JourneyError("failed", "hire_resource_coverage_exceeded");
      seen.add(key);
      const row = await readObserved<Row>(`/api/${kind === "agent" ? "agents" : "issues"}/${encodeURIComponent(event.entityId)}`);
      if (row.id !== event.entityId) throw new JourneyError("failed", "hire_resource_scope_mismatch");
      if (kind === "agent") agents.push(row as Agent); else tasks.push(row as Task);
      const observed = observedHireResources(scope, { agents: kind === "agent" ? [row] : [], tasks: kind === "issue" ? [row] : [], activity, leadRuns });
      scopeMismatch ||= observed.scopeMismatch;
      for (const resource of [...observed.agents.map(row => ({ kind: "agent" as const, id: row.id, name: row.name })),
        ...observed.tasks.map(row => ({ kind: "issue" as const, id: row.id, name: row.title }))]) {
        if (!known.has(resource.id)) { await session.own({ ...resource, journeyId: "hire-delegate-reuse" }); known.add(resource.id); }
      }
    }
    const owned = observedHireResources(scope, { agents, tasks, activity, leadRuns });
    if (scopeMismatch || owned.scopeMismatch) throw new JourneyError("failed", "hire_resource_scope_mismatch");
    if (owned.agents.length) {
      await readHireConnectionChoice({ get: readObserved }, { companyId: context.company.id, responsibleUserId: context.user.id,
        binding: lead.runtimeConfig.aiConnection, hiredId: owned.agents[0]!.id });
      const verified = assertHireBinding(scope, owned.agents, hiredId);
      if (hiredConnectionBinding === undefined) hiredConnectionBinding = Object.freeze(structuredClone(verified.runtimeConfig.aiConnection));
      else if (!isDeepStrictEqual(verified.runtimeConfig.aiConnection, hiredConnectionBinding)) throw new JourneyError("failed", "hire_native_binding_mismatch");
      hiredId = verified.id;
    }
    assertHireTaskCreation(scope, hiredId, owned.tasks, activity, leadRuns);
    const projectedRuns = [...leadProjection, ...(await Promise.all(owned.tasks.map(task => readRuns(task.id)))).flat()];
    const canonical = new Map<string, Run>();
    for (const run of projectedRuns) {
      const previous = canonical.get(run.id);
      if (previous && (previous.companyId !== run.companyId || previous.agentId !== run.agentId
        || hireRunIssueId(previous) !== hireRunIssueId(run))) throw new JourneyError("failed", "hire_run_scope_mismatch");
      if (!previous) canonical.set(run.id, run);
    }
    const runs = [...canonical.values()];
    const comments = await readObserved<Row[]>(`/api/issues/${chat.id}/comments?order=asc`);
    const requestIds = comments.filter(row => row.authorUserId === context.user.id).map(row => row.id);
    const completionRepliesReady = assertHireRuns(scope, hiredId, owned.tasks, runs, undefined, requestIds, comments);
    for (const run of projectedRuns) assertHireRuns(scope, hiredId, owned.tasks, [run], undefined, requestIds, comments);
    await retain("hire-delegate-observation.json", { scope: { ...scope, connectionBinding: undefined, connectionChoice: undefined }, chat, project,
      agents: owned.agents.map(row => ({ id: row.id, name: row.name, reportsTo: row.reportsTo })), tasks: owned.tasks,
      runs: runs.map(run => ({ id: run.id, issueId: hireRunIssueId(run), agentId: run.agentId, status: run.status })) });
    return { chat, ...owned, runs, requestIds, comments, completionRepliesReady, allAgents: [lead as Agent, ...agents], activity };
  };
  const waitForIdle = async (count: number) => {
    let awaitingReply = false;
    while (Date.now() < options.deadlineAt) {
      try {
        const state = await observe();
        awaitingReply = state?.completionRepliesReady === false;
        if (state && state.completionRepliesReady && state.runs.length === count && state.runs.every(run => run.status === "succeeded")
          && state.chat.status === "in_review" && state.chat.conversationState === "waiting") {
          assertHireRuns(scope!, hiredId, state.tasks, state.runs, count, state.requestIds, state.comments);
          return state;
        }
      } catch (error) {
        if (!(error instanceof HireReadTransportError)) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new JourneyError("failed", awaitingReply ? "hire_completion_reply_missing" : "hire_chat_not_completed");
  };
  const turn = async (text: string, count: number, handoff?: ReturnType<typeof hireHandoffMentions>) => {
    await page.goto(chatUrl, { waitUntil: "domcontentloaded" });
    const before = await api.get<Row | null>(chatPath);
    const prior = before ? await api.get<Row[]>(`/api/issues/${before.id}/comments?order=asc`) : [];
    if (handoff) await sendHireHandoffMessage(page, text, handoff, options.deadlineAt);
    else await sendChatMessage(page, text);
    const state = await waitForIdle(count);
    const comments = await api.get<Row[]>(`/api/issues/${state.chat.id}/comments?order=asc`);
    const added = comments.filter(row => row.authorUserId === context.user.id && !prior.some(old => old.id === row.id));
    check("hire-user-messages-stored-once", added.length === 1 && added[0].body === text);
    return state;
  };
  await session.own({ kind: "agent", name: names.hire, journeyId: "hire-delegate-reuse" });
  let state = await turn(`Hire exactly one teammate named ${names.hire}, reporting to you, using your native runner, model, and available AI connection. Do not create or start any tasks yet. Tell me when this teammate is ready.`, 1);
  const hired = assertHireBinding(scope!, state.agents);
  check("one-attributed-native-hire", state.tasks.length === 0);
  const handoff = hireHandoffMentions(scope!, hiredId!, hired, project);
  const marker = `HIRE${campaignId.replace(/[^a-z0-9]/gi, "")}`;
  await session.own({ kind: "issue", name: names.checklist, journeyId: "hire-delegate-reuse" });
  state = await turn(`Have the existing ${handoff.teammate} write a concise launch checklist as a saved Paperclip document with the line "Reference: ${marker}". Create exactly one task titled ${names.checklist} in ${handoff.project}, already assigned to that teammate when it is created. Link the result here and let the teammate complete it. Do not hire another agent.`, 4, handoff);
  const first = state.tasks.find(task => task.title === names.checklist);
  check("first-delegated-task-complete", typeof first?.identifier === "string" && state.tasks.length === 1);
  const readOutput = async (task: Row, token: string, runs: Row[]) => {
    const document = await readChatOutputDocument(api, task.id, token);
    const revisions = await api.get<Row[]>(`/api/issues/${task.id}/documents/${encodeURIComponent(document.key)}/revisions`);
    assertHireDocument(scope!, task, document, revisions, runs, token, hired.id);
    return document;
  };
  const firstOutput = await readOutput(first!, marker, state.runs);
  const originalTask = mutableIssueSnapshot(await api.get<Task>(`/api/issues/${first!.id}`));
  check("checklist-authored-by-hired-run");
  await session.own({ kind: "issue", name: names.review, journeyId: "hire-delegate-reuse" });
  state = await turn(`Have the existing ${handoff.teammate} review the checklist on ${first!.identifier} and write a separate saved review document with the line "Reference: REVIEW${marker}". Create exactly one task titled ${names.review} in ${handoff.project}, already assigned to that same teammate when it is created. Include the actual checklist in the handoff. Preserve the original checklist and task. Link the completed review here. Do not hire another agent.`, 7, handoff);
  const second = state.tasks.find(task => task.title === names.review);
  check("same-teammate-reused", typeof second?.identifier === "string" && state.tasks.length === 2 && state.tasks.every(task => taskNames.includes(task.title)));
  const reviewOutput = await readOutput(second!, `REVIEW${marker}`, state.runs);
  check("review-authored-by-same-hired-run");
  check("original-checklist-preserved", isDeepStrictEqual(await api.get(`/api/issues/${first!.id}/documents/${encodeURIComponent(firstOutput.key)}`), firstOutput)
    && isDeepStrictEqual(mutableIssueSnapshot(await api.get<Task>(`/api/issues/${first!.id}`)), originalTask));
  if (hiredConnectionBinding === undefined || !isDeepStrictEqual(
    state.agents.find(row => row.id === hired.id)?.runtimeConfig?.aiConnection, hiredConnectionBinding)) {
    throw new JourneyError("failed", "hire_native_binding_mismatch");
  }
  assertChatHire({ agents: state.allAgents, leadId: agent.id, hireName: names.hire, hiredId: hired.id,
    connectionId: connectionChoice?.connectionId ?? lead.runtimeConfig.aiConnection.connectionId, binding: hiredConnectionBinding,
    taskIds: [first!.id, second!.id], tasks: state.tasks, runs: state.runs });
  assertHireRuns(scope!, hired.id, state.tasks, state.runs, 7, state.requestIds, state.comments);
  const comments = await api.get<Row[]>(`/api/issues/${state.chat.id}/comments?order=asc`);
  assertHireRuns(scope!, hired.id, state.tasks, state.runs, 7, state.requestIds, comments);
  let resultsVisible = true;
  for (const task of [first!, second!]) {
    const callback = state.runs.find(run => {
      const updates = run.contextSnapshot?.chatCompletionUpdates;
      return run.contextSnapshot?.wakeReason === "chat_task_completed" && Array.isArray(updates) && updates[0]?.id === task.id;
    });
    if (!callback) throw new JourneyError("failed", "hire_completion_binding_mismatch");
    await page.goto(chatUrl, { waitUntil: "domcontentloaded" }); await page.reload();
    if (!await openSavedHireResult(page, api.origin, context.company.issuePrefix, comments, agent.id, task,
      options.deadlineAt, { companyId: scope!.companyId, chatId: scope!.chatId, runId: callback.id })) {
      resultsVisible = false; break;
    }
  }
  check("delegated-result-visible-after-reload", resultsVisible);
  check("configured-model-and-environment");
  await retain("hire-delegate-completed.json", { hiredId: hired.id, firstTaskId: first!.id, secondTaskId: second!.id,
    firstDocument: firstOutput, reviewDocument: reviewOutput, runIds: state.runs.map(run => run.id),
    turns: state.runs.map(run => ({ id: run.id, issueId: hireRunIssueId(run), agentId: run.agentId,
      wakeReason: run.contextSnapshot?.wakeReason, wakeCommentId: run.contextSnapshot?.wakeCommentId,
      chatCompletionDeliveryIds: run.contextSnapshot?.chatCompletionDeliveryIds, chatCompletionUpdates: run.contextSnapshot?.chatCompletionUpdates })),
    completionReplies: state.comments.filter(comment => state.runs.some(run => run.id === comment.createdByRunId
      && run.contextSnapshot?.wakeReason === "chat_task_completed")).map(comment => ({ id: comment.id, createdByRunId: comment.createdByRunId })) });
  await options.capture("hire-delegate-reuse", "Hired teammate completed and reused", "hire-delegate-reuse.png");
}

export async function openSavedHireResult(page: Page, origin: string, issuePrefix: string, comments: Row[], leadId: string, task: Row, deadlineAt: number,
  callback: { companyId: string; chatId: string; runId: string }) {
  while (Date.now() < deadlineAt) {
    for (const comment of comments.filter(row => row.authorAgentId === leadId && !row.authorUserId
      && row.companyId === callback.companyId && row.issueId === callback.chatId && row.createdByRunId === callback.runId)) {
      const reply = page.locator(`[id=${JSON.stringify(`comment-${comment.id}`)}]`);
      if (!await reply.isVisible()) continue;
      const links = await reply.locator("a[href]").evaluateAll(elements => elements.map(element => element.getAttribute("href")!));
      const href = links.find(href => hireResultLinkMatches({ origin, issuePrefix }, task, href));
      if (!href) continue;
      await reply.locator(`a[href=${JSON.stringify(href)}]`).first().click({ timeout: Math.max(1, deadlineAt - Date.now()) });
      await page.reload();
      await expect(page).toHaveURL(url => url.origin === origin
        && [task.id, task.identifier].some(id => url.pathname === `/${issuePrefix}/issues/${id}`), { timeout: Math.max(1, deadlineAt - Date.now()) });
      await expect(page.getByTestId("issue-detail-header").getByRole("heading", { name: task.title, exact: true }))
        .toBeVisible({ timeout: Math.max(1, deadlineAt - Date.now()) });
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(200, Math.max(1, deadlineAt - Date.now()))));
  }
  return false;
}
