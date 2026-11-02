import { createObservedReader } from "./observation-read.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { buildAgentMentionHref, buildProjectMentionHref } from "../../../packages/shared/src/project-mentions.js";
import { completionDelivery, type CompletionObservation } from "../completion-updates.js";
import { completionJourneyChecks, completionTaskCreationMatches, type CompletionScope } from "./completion-delivery-evidence.js";
import { hireRunIssueId } from "./hire-delegate-evidence.js";
import { sendHireHandoffMessage } from "./hire-delegate-composer.js";
import { openDocumentAuthoring } from "./task-document-flow.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

type Row = Record<string, any>;
interface Options { deadlineAt: number; directory: string; capture(id: string, label: string, file: string): Promise<void> }
const journeyId = "completion-delivery" as const;
export async function completionDeliveryJourney(context: JourneyContext, session: TargetSession, campaignId: string, evidence: JourneyEvidence, options: Options) {
  const { page, api, company, user } = context, lead = context.agent, worker = context.fixtures?.completionWorker;
  let windowEndsAt: number | undefined, observationComplete = false;
  const observations = createObservedReader(api, () => observationComplete ? options.deadlineAt : Math.min(options.deadlineAt, windowEndsAt ?? Infinity));
  const readObserved = observations.get;
  try {
    if (!lead || !worker || lead.runtimeMode !== "native" || worker.runtimeMode !== "native" || !context.environmentId
      || lead.id === worker.id || lead.provider !== worker.provider || lead.model !== worker.model) {
      throw new JourneyError("unsupported", "completion_worker_fixture_required");
    }
    const agents = await Promise.all([lead, worker].map(agent => readObserved<Row>(`/api/agents/${agent.id}`)));
    if (agents.some((row, index) => row.id !== [lead, worker][index]!.id || row.companyId !== company.id
      || row.name !== [lead, worker][index]!.name || row.adapterType !== "paperclip_runner"
      || row.adapterConfig?.model !== lead.model || row.defaultEnvironmentId !== context.environmentId)
      || agents[1]!.reportsTo !== lead.id) throw new JourneyError("failed", "completion_agent_fixture_mismatch");
    if ((await readObserved<Row>("/api/instance/settings/experimental")).enableAgentChat !== true) {
      throw new JourneyError("unsupported", "agent_chat_required");
    }
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const retain = (value: unknown) => writeFile(path.join(options.directory, "completion-delivery.json"), JSON.stringify(value, null, 2), { mode: 0o600 });
    const check = (id: string, passed: boolean) => {
      evidence.checks.push({ id, passed }); if (!passed) throw new JourneyError("failed", id.replaceAll("-", "_"));
    };
    const projectName = `Journey QA completion-delivery ${campaignId}`, taskTitle = `Completion brief ${campaignId}`;
    await session.own({ kind: "project", name: projectName, journeyId });
    const project = await api.post<Row>(`/api/companies/${company.id}/projects`, { name: projectName, description: "Disposable delegated completion delivery verification." });
    if (project.companyId !== company.id || project.name !== projectName || !project.id) throw new JourneyError("failed", "completion_project_mismatch");
    await session.own({ kind: "project", name: projectName, id: project.id, journeyId });
    const chatPath = `/api/companies/${company.id}/chats/${lead.id}`, chatUrl = `${api.origin}/${company.issuePrefix}/chats/${lead.id}`;
    if (await readObserved(chatPath)) throw new JourneyError("unsupported", "fresh_lead_chat_required");
    const freshChat = { companyId: company.id, userId: user.id, leadAgentId: lead.id, absent: true as const };
    await session.own({ kind: "issue", name: `Chat with ${lead.name}`, journeyId, freshChat });
    await session.own({ kind: "issue", name: taskTitle, journeyId });
    await page.goto(chatUrl, { waitUntil: "domcontentloaded" });
    const references = { teammate: `[@${worker.name}](${buildAgentMentionHref(worker.id, agents[1]!.icon ?? null)})`,
      project: `[@${project.name}](${buildProjectMentionHref(project.id, project.color ?? null)})` };
    const marker = `COMPLETION${campaignId.replace(/[^a-z0-9]/gi, "")}`;
    const expectedBody = `Reference: ${marker}\nVerify the release with the smoke suite.\nRoll back the release if the smoke suite fails.`;
    const request = `Have the existing ${references.teammate} write a saved Paperclip document with key completion-brief and exactly these three lines: "Reference: ${marker}"; "Verify the release with the smoke suite."; "Roll back the release if the smoke suite fails.". Create exactly one task titled ${taskTitle} in ${references.project}, already assigned to that teammate when it is created. Let the teammate do the work and mark it Done. Return the completed result here when it is ready, with a link to the saved result. Do not hire another agent or create other work.`;
    await sendHireHandoffMessage(page, request, references, options.deadlineAt);
    let scope: CompletionScope | undefined, task: Row | undefined, observation: CompletionObservation | undefined;
    let revisions: Row[] = [], events: Row[] = [], checks: Array<{ id: string; passed: boolean }> = [];
    const owned = new Set<string>();
    try {
      while (Date.now() < options.deadlineAt) {
        if (windowEndsAt && Date.now() >= windowEndsAt) break;
        const chat = await readObserved<Row | null>(chatPath);
        if (!chat) { await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
        if (chat.companyId !== company.id || chat.assigneeAgentId !== lead.id || chat.conversationAgentId !== lead.id
          || chat.conversationUserId !== user.id || chat.createdByUserId !== user.id || chat.title !== `Chat with ${lead.name}`
          || scope && scope.sourceId !== chat.id) throw new JourneyError("failed", "completion_chat_scope_mismatch");
        scope ??= { companyId: company.id, sourceId: chat.id, userId: user.id, leadId: lead.id, workerAgentId: worker.id,
          projectId: project.id, taskTitle, provider: lead.provider, model: lead.model, environmentId: context.environmentId };
        if (!owned.has(chat.id)) {
          await session.own({ kind: "issue", name: chat.title, id: chat.id, journeyId, freshChat }); owned.add(chat.id);
        }
        const readRuns = async (issueId: string) => {
          const summaries = await readObserved<Row[]>(`/api/issues/${issueId}/runs`);
          if (!Array.isArray(summaries) || summaries.length > 3) throw new JourneyError("failed", "completion_run_limit_exceeded");
          return Promise.all(summaries.map(row => readObserved<Row>(`/api/heartbeat-runs/${row.runId}`)));
        };
        const sourceRuns = await readRuns(chat.id);
        events = await readObserved<Row[]>(`/api/companies/${company.id}/activity?agentId=${lead.id}&limit=500`);
        if (!Array.isArray(events) || events.length >= 500) throw new JourneyError("failed", "completion_audit_coverage_unavailable");
        const created = events.filter(event => event.companyId === company.id && event.actorType === "agent" && event.actorId === lead.id
          && event.agentId === lead.id && event.entityType === "issue" && ["issue.created", "issue.child_created"].includes(event.action)
          && sourceRuns.some(run => run.id === event.runId && run.runtimeMode === "native" && run.agentId === lead.id && hireRunIssueId(run) === chat.id));
        const ids = [...new Set(created.map(event => event.entityId))];
        for (const id of ids) {
          const row = await readObserved<Row>(`/api/issues/${id}`);
          // The private adapter rechecks native creation proof before accepting a
          // receipt. Own discovered children before an outcome assertion can fail.
          if (!owned.has(row.id)) { await session.own({ kind: "issue", name: row.title, id: row.id, journeyId }); owned.add(row.id); }
          if (ids.length !== 1 || row.id !== id || !completionTaskCreationMatches(scope, row, events, sourceRuns)) {
            throw new JourneyError("failed", "completion_delegated_task_mismatch");
          }
          if (task && task.id !== row.id) throw new JourneyError("failed", "completion_worker_task_replaced");
          task = row;
        }
        if (task) {
          task = await readObserved<Row>(`/api/issues/${task.id}`);
          const projected = [...sourceRuns, ...await readRuns(task.id)];
          const runs = [...new Map(projected.map(run => [run.id, run])).values()];
          if (runs.length > 3 || runs.some(run => run.companyId !== company.id
            || !(run.agentId === lead.id && hireRunIssueId(run) === chat.id || run.agentId === worker.id && hireRunIssueId(run) === task!.id)
            || !["queued", "running", "succeeded"].includes(run.status))) throw new JourneyError("failed", "completion_run_binding_mismatch");
          const documents = await readObserved<Row[]>(`/api/issues/${task.id}/documents`);
          const full = await Promise.all(documents.map(document => readObserved<Row>(`/api/issues/${task!.id}/documents/${encodeURIComponent(document.key)}`)));
          const output = full.find(document => document.key === "completion-brief");
          revisions = output ? await readObserved<Row[]>(`/api/issues/${task.id}/documents/completion-brief/revisions`) : [];
          observation = { sourceId: chat.id, worker: task, documents: full, runs, marker, fixtureRequest: request,
            comments: await readObserved<Row[]>(`/api/issues/${chat.id}/comments?order=asc`), renderedLinks: [] };
          for (const response of completionDelivery(observation).responses) {
            const reply = page.locator(`[id=${JSON.stringify(`comment-${response.id}`)}]`);
            observation.renderedLinks!.push(...(await reply.locator("a[href]").evaluateAll(nodes => nodes.map(node => node.getAttribute("href")!)))
              .map(href => ({ commentId: response.id, href })));
          }
          checks = completionJourneyChecks(scope, observation, { request, expectedBody, revisions, events });
          if (task.status === "done") windowEndsAt ??= Date.now() + 120_000;
          await retain({ scope, observation, revisions, checks });
          // Retain a full post-completion window, including later corrections.
          // There is no second user message, poke, manual retry, or work replay.
          if (windowEndsAt && Date.now() >= windowEndsAt) break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!scope || !observation || !task || !windowEndsAt || Date.now() < windowEndsAt) throw new JourneyError("failed", "completion_delivery_missing");
      for (const item of checks) check(item.id, item.passed);
      observationComplete = true;
      const delivery = completionDelivery(observation), response = delivery.response;
      if (!response) throw new JourneyError("failed", "completion_reply_missing");
      await page.reload({ waitUntil: "domcontentloaded" });
      const reply = page.locator(`[id=${JSON.stringify(`comment-${response.id}`)}]`);
      await expect(reply).toBeVisible();
      if (delivery.resultLinks.length) {
        const href = delivery.resultLinks[0]!, url = new URL(href, api.origin);
        if (url.origin !== api.origin || ![task.id, task.identifier].some(id => url.pathname === `/${company.issuePrefix}/issues/${id}`)) {
          throw new JourneyError("failed", "completion_result_link_scope_mismatch");
        }
        await expect(reply.locator(`a[href=${JSON.stringify(href)}]`).first()).toBeVisible();
        await reply.locator(`a[href=${JSON.stringify(href)}]`).first().click();
      } else {
        await expect(reply).toContainText(expectedBody);
        await page.goto(`${api.origin}/${company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
      }
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("issue-detail-header").getByRole("heading", { name: task.title, exact: true })).toBeVisible();
      await openDocumentAuthoring(context);
      await expect(page.locator("#document-completion-brief")).toContainText(marker);
      const reopened = await readObserved<Row>(`/api/issues/${task.id}/documents/completion-brief`);
      const original = observation.documents.find(document => document.key === "completion-brief");
      check("completion-result-reopened", reopened.id === original?.id && reopened.latestRevisionId === original?.latestRevisionId && reopened.body === original?.body);
      check("configured-model-and-environment", true);
      await options.capture(journeyId, "Delegated completion result reopened", "completion-delivery.png");
    } finally {
      await retain({ scope, observation, revisions, checks });
    }
  } finally { await observations.preserve(options.directory); }
}
