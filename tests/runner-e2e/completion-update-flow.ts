import { expect, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveManagedProjectWorkspaceDir } from "../../server/src/home-paths.js";
import { pollUntil, type RunnerApi } from "./api.js";
import { sendChatMessage, readChatOutputDocument, collectChatRunEvidence, type ChatFlowInput, type ChatRun } from "./chat-flow.js";
import { prepareChatBrief } from "./chat-stories.js";
import { completionDelivery, completionOutputUsesReleasedBrief, type CompletionObservation } from "./completion-updates.js";

type Row = Record<string, any>;
export async function observeCompletionUpdate(input: {
  page: Page; api: RunnerApi; sourceId: string; workerId: string; marker: string;
  allRuns(): Promise<Row[]>;
  evidence(name: string, data: unknown): Promise<void>;
  capture(id: string, label: string, file: string): Promise<void>;
}) {
  const startedAt = new Date().toISOString();
  const observationWindowEndsAt = Date.now() + 120_000;
  let observation: CompletionObservation | undefined;
  let failure: unknown;
  try {
    await pollUntil({
      label: "unsolicited source-thread completion reply and result access",
      // Keep observing even after an early reply, so a later correction is retained.
      deadlineAt: observationWindowEndsAt + 5_000, intervalMs: 1000,
      load: async () => {
        const worker = await input.api.get<Row>(`/api/issues/${input.workerId}`);
        const documents = await input.api.get<Row[]>(`/api/issues/${input.workerId}/documents`);
        observation = {
          sourceId: input.sourceId, worker, marker: input.marker,
          documents: await Promise.all(documents.map(d => input.api.get<Row>(`/api/issues/${worker.id}/documents/${encodeURIComponent(d.key)}`))),
          comments: await input.api.get<Row[]>(`/api/issues/${input.sourceId}/comments?order=asc`),
          runs: await input.allRuns(),
        };
        observation.renderedLinks = [];
        for (const response of completionDelivery(observation).responses) {
          const reply = input.page.locator(`[id=${JSON.stringify(`comment-${response.id}`)}]`);
          observation.renderedLinks.push(...(await reply.locator("a[href]").evaluateAll(elements =>
            elements.map(element => element.getAttribute("href")!))).map(href => ({ commentId: response.id, href })));
        }
        return completionDelivery(observation);
      },
      accept: result => Date.now() >= observationWindowEndsAt && result.checks.every(c => c.passed),
      reject: () => observation!.runs.length > 12 ? "completion probe exceeded 12 runs" : undefined,
      timeoutDetail: result => result?.checks.filter(c => !c.passed).map(c => c.id).join(", "),
    });
    const delivery = completionDelivery(observation!);
    if (!delivery.response) throw new Error("Completion observation lost its source reply");
    // Verify browser persistence, not just an API comment. No new user input.
    await input.page.reload({ waitUntil: "domcontentloaded" });
    const reply = input.page.locator(`[id=${JSON.stringify(`comment-${delivery.response.id}`)}]`);
    await expect(reply).toBeVisible();
    if (delivery.resultLinks.length) {
      const link = delivery.resultLinks[0]!;
      const url = new URL(link, input.api.baseURL);
      expect(url.origin).toBe(new URL(input.api.baseURL).origin);
      await expect(reply.locator(`a[href=${JSON.stringify(link)}]`).first()).toBeVisible();
      const sourceUrl = input.page.url();
      try {
        // A client-side route can return HTTP 200 even when the task is missing.
        // Open the actual rendered target and prove that its task loaded.
        await input.page.goto(url.href, { waitUntil: "domcontentloaded" });
        await expect(input.page.getByRole("heading", { name: String(observation!.worker.title), exact: true })).toBeVisible();
        const accessibleWorker = await input.api.get<Row>(`/api/issues/${encodeURIComponent(observation!.worker.identifier ?? input.workerId)}`);
        expect(accessibleWorker.id).toBe(input.workerId);
        const accessibleOutput = await readChatOutputDocument(input.api, accessibleWorker.id, input.marker);
        expect(observation!.documents.some(d => d.id === accessibleOutput.id && d.body === accessibleOutput.body)).toBe(true);
      } finally {
        await input.page.goto(sourceUrl, { waitUntil: "domcontentloaded" });
        await expect(reply).toBeVisible();
      }
    } else {
      await expect(reply).toContainText(input.marker);
    }
    return observation!;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const evidenceErrors: string[] = [];
    const preserve = async (label: string, collect: () => Promise<void>) => {
      try { await collect(); }
      catch (error) { evidenceErrors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
    };
    await preserve("observation", () => input.evidence("completion-update.json", {
      schema: "paperclip.completion-update-probe.v6", startedAt, finishedAt: new Date().toISOString(),
      observation, delivery: observation ? completionDelivery(observation) : null,
      observedFailure: failure instanceof Error ? failure.message : null,
    }));
    await preserve("screenshot", () => input.capture("completion-update", "Originating thread after delegated completion", "completion-update.png"));
    if (observation) await preserve("run evidence", async () => {
      const results = await Promise.allSettled(observation!.runs.map(run => collectChatRunEvidence(input.api, run as ChatRun)));
      await input.evidence("completion-update-run-evidence.json", results.map((result, index) => {
        if (result.status === "fulfilled") return result.value;
        const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
        evidenceErrors.push(`run ${observation!.runs[index]!.id}: ${error}`);
        return { runId: observation!.runs[index]!.id, evidenceError: error };
      }));
    });
    if (evidenceErrors.length) {
      await input.evidence("completion-update-evidence-errors.json", { errors: evidenceErrors }).catch(() => {});
      // Preserve the behavior failure. A successful probe still needs its evidence.
      if (!failure) throw new Error(`Completion evidence collection failed: ${evidenceErrors.join("; ")}`);
    }
  }
}

export async function runChatCompletionUpdate(context: {
  input: ChatFlowInput; marker: string; allRuns(): Promise<ChatRun[]>; refreshIssue(): Promise<void>; issue(): { id: string };
}) {
  const { input, marker } = context;
  const { api, fixtures: f, execution, page } = input;
  const company = `/api/companies/${f.company.id}`;
  const config = execution.profile.buildAgent({ environmentId: f.environment.id, environmentFixtureId: "local", workspacePath: input.workspacePath, secretRefs: f.secretRefs, executionId: input.nonce });
  const worker = await api.post<Row>(`${company}/agents`, { ...config, name: "Riley Writer", role: "engineer", reportsTo: f.agent.id });
  const project = await api.post<Row>(`${company}/projects`, { name: "Garden welcome", description: "A non-code neighborhood garden meetup. No repository needed." });
  // A project task runs in its managed project workspace. The agent-home path
  // used by projectless chats is outside the native Codex workspace projection.
  const workspace = resolveManagedProjectWorkspaceDir({ companyId: f.company.id, projectId: project.id });
  const relative = path.relative(path.dirname(input.workspacePath), workspace);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Completion fixture escaped isolated instance");
  const wait = await prepareChatBrief(workspace, input.nonce, 240_000);
  const reference = marker;
  const instructions = `For the welcome-note assignment, run node ${wait.scriptPath} to read the organizer's brief before writing the final note. Save a two-sentence welcome note as a Paperclip document on your assigned task using the brief's details and reference. Then complete your task. Do not edit or comment on another task.`;
  const saved = await api.request.put(`/api/agents/${worker.id}/instructions-bundle/file`, { data: { path: "AGENTS.md", content: instructions } });
  expect(saved.ok()).toBe(true);
  expect(await api.get(`/api/agents/${worker.id}/instructions-bundle/file?path=AGENTS.md`)).toMatchObject({ content: instructions });
  const prompt = `Create one task in the Garden welcome project (${project.id}) assigned to Riley Writer to write a two-sentence welcome note for our free Friday garden meetup. Riley has the organizer's brief. Save the finished note on that task and include ${marker}. Please tell me here when the work is finished and give me access to the result. You may start the handoff now; no further approval is needed. Let Riley write the note.`;
  let task: Row | undefined;
  try {
    await sendChatMessage(page, prompt);
    await pollUntil({ label: "worker waiting while originating chat is idle", deadlineAt: Date.now() + 180_000, intervalMs: 1000,
      load: async () => {
        await context.refreshIssue();
        const source = await api.get<Row>(`/api/issues/${context.issue().id}`);
        const tasks = await api.get<Row[]>(`${company}/issues`);
        task = tasks.find(t => t.assigneeAgentId === worker.id);
        const runs = await context.allRuns();
        return { source, tasks, runs, ready: await readFile(wait.ready, "utf8").catch(() => "") };
      },
      accept: state => Boolean(task) && state.ready === "waiting" && state.source.conversationState === "waiting" &&
        state.runs.some(r => r.contextSnapshot?.issueId === task!.id && r.status === "running") &&
        state.runs.some(r => r.contextSnapshot?.issueId === state.source.id && r.status === "succeeded") &&
        !state.runs.some(r => r.contextSnapshot?.issueId === state.source.id && ["queued", "running"].includes(r.status)),
    });
    expect(task!.parentId).toBeNull();
    expect(task!.projectId).toBe(project.id);
    await input.evidence("completion-update-boundary.json", { task, source: await api.get(`/api/issues/${context.issue().id}`), runs: await context.allRuns(), gateReady: true, prompt, reference });
    await input.capture("completion-idle", "Chat is idle while Riley waits for the brief", "completion-idle.png");
    await writeFile(wait.gate, `The free Friday meetup starts at 10:30 in the community garden. Reference: ${reference}.`);
    await pollUntil({ label: "delegated welcome note completed", deadlineAt: Date.now() + 180_000, intervalMs: 1000,
      load: () => api.get<Row>(`/api/issues/${task!.id}`), accept: t => t.status === "done" });
    const output = await readChatOutputDocument(api, task!.id, marker);
    await input.evidence("completion-update-worker-output.json", { task: await api.get(`/api/issues/${task!.id}`), output });
    await observeCompletionUpdate({ ...input, sourceId: context.issue().id, workerId: task!.id, marker, allRuns: context.allRuns });
    // Always capture completion delivery before grading how the worker phrased the brief.
    expect(completionOutputUsesReleasedBrief(output.body), "worker output must use the start time supplied only in the released brief").toBe(true);
    expect((await api.get<Row[]>(`${company}/issues`)).map(t => t.id)).toEqual([task!.id]);
    expect(await api.get(`/api/issues/${task!.id}/documents/${encodeURIComponent(output.key)}`)).toEqual(output);
    const comments = await api.get<Row[]>(`/api/issues/${context.issue().id}/comments?order=asc`);
    expect(comments.filter(c => c.authorUserId).map(c => c.body)).toEqual([prompt]);
  } finally {
    await writeFile(wait.gate, `Reference: ${reference}`);
    await context.refreshIssue();
  }
}
