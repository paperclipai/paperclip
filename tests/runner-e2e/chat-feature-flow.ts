import { expect } from "@playwright/test";
import { pollUntil } from "./api.js";
import { collectChatRunEvidence, sendChatMessage, type ChatFlowInput, type ChatIssue, type ChatRun } from "./chat-flow.js";
import { FixtureRegistry } from "./fixture-registry.js";
import { codexSubscriptionAgentConfig } from "./codex-subscription-fixture.js";
import { CHAT_FEATURE_BUDGET_CENTS, CHAT_FEATURE_GRADER, chatFeatureScenarios, type ChatFeatureCase } from "./chat-feature-cases.js";
import { chatFeatureExecutionRuns, gradeChatFeature, linksFeatureTask, type ChatFeatureObservation, type FeatureDocument, type FeatureTask } from "./chat-feature-scoring.js";

export async function runChatFeatureFlow(context: {
  input: ChatFlowInput; issue(): ChatIssue | undefined; allRuns(): Promise<ChatRun[]>; refreshIssue(): Promise<void>;
}) {
  const { input } = context;
  const { api, page, fixtures: f, execution, nonce } = input;
  const caseId = execution.task.id as ChatFeatureCase;
  const scenario = chatFeatureScenarios.find(row => row.id === `tasks.${caseId}`);
  if (!scenario) throw new Error(`Unregistered chat feature scenario: ${caseId}`);
  const marker = execution.task.buildVisibleMarker(nonce);
  const brief = `Acorn Notes launches on November 12. The invitation code is ${marker}. Write a welcoming announcement that includes the product name, date and invitation code.`;
  const company = `/api/companies/${f.company.id}`;
  const setupObservations: Array<Record<string, unknown>> = [];
  const registry = new FixtureRegistry();
  registry.register<{ id: string }>({ id: "project", setup: () => api.post(`${company}/projects`, { name: "Launch", description: brief }) });
  registry.register<{ id: string }>({ id: "worker", dependencies: ["project"], async setup() {
    const base = execution.profile.buildAgent({ environmentId: f.environment.id, environmentFixtureId: execution.environment.id,
      workspacePath: input.workspacePath, secretRefs: f.secretRefs, executionId: nonce });
    const worker = { ...base, name: "Morgan", role: "engineer", title: "Engineer", reportsTo: f.agent.id,
      capabilities: "Writes clear product announcements using the project brief.",
      runtimeConfig: { ...(base.runtimeConfig as Record<string, unknown>),
        heartbeat: { enabled: false, maxConcurrentRuns: 1, maxDailyRuns: 1, maxDailyCostCents: CHAT_FEATURE_BUDGET_CENTS } } };
    return api.post(`${company}/agents`, execution.profile.credential === "CODEX_AUTH_JSON"
      ? codexSubscriptionAgentConfig(worker, process.env, f.company.id) : worker);
  } });
  const fixtures = await registry.setupAll();
  const projectId = (fixtures.values.get("project") as { id: string }).id;
  const workerId = (fixtures.values.get("worker") as { id: string }).id;
  let observation: ChatFeatureObservation = { caseId, companyId: f.company.id, leadId: f.agent.id, workerId, projectId,
    source: null, tasks: [], runs: [], comments: [], documents: [], activity: [], query: scenario.query, marker, renderedLinks: [] };
  let failure: unknown;
  async function refresh() {
    await context.refreshIssue();
    const source = context.issue();
    const [tasks, runs, comments] = await Promise.all([
      api.get<FeatureTask[]>(`${company}/issues?includeAgentCreatedTasks=true&limit=100`), context.allRuns(),
      source ? api.get<ChatFeatureObservation["comments"]>(`/api/issues/${source.id}/comments?order=asc`) : [],
    ]);
    const task = tasks.length === 1 ? tasks[0] : undefined;
    const documents: FeatureDocument[] = [];
    if (task) {
      const summaries = await api.get<Array<{ key: string }>>(`/api/issues/${task.id}/documents`);
      for (const summary of summaries) {
        const endpoint = `/api/issues/${task.id}/documents/${encodeURIComponent(summary.key)}`;
        const [detail, revisions] = await Promise.all([api.get<Omit<FeatureDocument, "revisions">>(endpoint), api.get<FeatureDocument["revisions"]>(`${endpoint}/revisions`)]);
        documents.push({ ...detail, issueId: task.id, revisions });
      }
    }
    const renderedLinks: ChatFeatureObservation["renderedLinks"] = [];
    for (const comment of comments.filter(row => row.authorAgentId === f.agent.id)) {
      const reply = page.locator(`[id=${JSON.stringify(`comment-${comment.id}`)}]`);
      const links = await reply.locator("a[href]").evaluateAll(elements => elements.map(element => element.getAttribute("href")!));
      for (const href of links) {
        const url = new URL(href, api.baseURL);
        renderedLinks.push({ commentId: comment.id, href: url.origin === api.baseURL ? `${url.pathname}${url.search}${url.hash}` : href });
      }
    }
    observation = { ...observation, source: source ?? null, tasks, runs, comments, documents, renderedLinks,
      activity: task ? await api.get<ChatFeatureObservation["activity"]>(`/api/issues/${task.id}/activity`) : [] };
    return gradeChatFeature(observation);
  }
  async function saveEvidence() {
    await input.evidence("chat-feature.json", { schema: CHAT_FEATURE_GRADER, scenarioId: scenario!.id,
      capabilities: scenario!.capabilities, observation, grade: gradeChatFeature(observation),
      setupObservations, setupUsageCoverage: "Production agent hello probes are outside heartbeat usage; their detailed tokens and cost are unavailable." });
  }
  try {
    expect(await api.get(`${company}/issues?includeAgentCreatedTasks=true`)).toEqual([]);
    for (const agentId of [f.agent.id, workerId]) {
      await pollUntil({ label: `chat feature agent readiness ${agentId}`, deadlineAt: Date.now() + 45_000, intervalMs: 500,
        load: async () => {
          const agent = await api.get<{ lifecycleState: string; status: string; lifecycleError?: string; lifecycleHolds?: string[] }>(`/api/agents/${agentId}`);
          setupObservations.push({ agentId, lifecycleState: agent.lifecycleState, status: agent.status });
          return agent;
        },
        accept: agent => agent.lifecycleState === "ready" && ["idle", "active"].includes(agent.status),
        reject: agent => agent.lifecycleError ? "Agent setup failed; inspect retained setup state"
          : agent.lifecycleHolds?.length ? "Agent setup held" : undefined,
      });
    }
    const budgets = await Promise.all([api.get<Record<string, unknown>>(company), ...[f.agent.id, workerId].map(id => api.get<Record<string, unknown>>(`/api/agents/${id}`))]);
    expect(budgets.every(record => record.budgetMonthlyCents === CHAT_FEATURE_BUDGET_CENTS), "Saved company and both agent budget limits").toBe(true);
    const scopes = [{ scopeType: "company", scopeId: f.company.id }, ...[f.agent.id, workerId].map(scopeId => ({ scopeType: "agent", scopeId }))];
    for (const scope of scopes) await api.post(`${company}/budgets/policies`, { ...scope,
      amount: CHAT_FEATURE_BUDGET_CENTS, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
    const { policies } = await api.get<{ policies: Array<{ scopeType: string; scopeId: string; amount: number; hardStopEnabled: boolean; isActive: boolean; unpricedUsagePolicy: string }> }>(`${company}/budgets/overview`);
    const funding = policies.filter(policy => scopes.some(scope => scope.scopeType === policy.scopeType && scope.scopeId === policy.scopeId))
      .map(({ scopeType, scopeId, amount, hardStopEnabled, isActive, unpricedUsagePolicy }) => ({ scopeType, scopeId, amount, hardStopEnabled, isActive, unpricedUsagePolicy }));
    expect(funding).toHaveLength(3);
    expect(funding.every(policy => policy.amount === CHAT_FEATURE_BUDGET_CENTS && policy.hardStopEnabled && policy.isActive && policy.unpricedUsagePolicy === "allow")).toBe(true);
    await input.evidence("chat-feature-setup.json", { scenarioId: scenario.id, companyId: f.company.id,
      leadId: f.agent.id, workerId, projectId, brief, budgetMonthlyCents: CHAT_FEATURE_BUDGET_CENTS,
      maximumProviderRuns: execution.task.expectedRunCount, providerRunTimeoutMs: execution.task.turnTimeoutMs,
      setupObservations, funding, instructions: "Production role defaults; no fixture procedure or expected outcome is injected." });
    await sendChatMessage(page, scenario.query);
    let settledAt: number | undefined;
    let finishedWorkAt: number | undefined;
    await pollUntil({ label: `chat scenario ${scenario.id}`, deadlineAt: Date.now() + 300_000, intervalMs: 1_000,
      load: refresh,
      accept: grade => {
        if (!grade.passed) { settledAt = undefined; return false; }
        settledAt ??= Date.now();
        return Date.now() - settledAt >= 5_000;
      },
      reject: grade => {
        const runs = chatFeatureExecutionRuns(observation);
        if (runs.length > execution.task.expectedRunCount) return "Chat exceeded its declared run bound";
        if (runs.some(run => ["failed", "cancelled", "timed_out"].includes(run.status))) return "An observed provider run failed";
        const finished = runs.length === execution.task.expectedRunCount && runs.every(run => run.status === "succeeded")
          && observation.source?.conversationState === "waiting";
        if (!finished) finishedWorkAt = undefined;
        else finishedWorkAt ??= Date.now();
        if (!grade.passed && finishedWorkAt && Date.now() - finishedWorkAt >= 15_000)
          return `Settled chat failed: ${grade.checks.filter(check => !check.passed).map(check => check.id).join(", ")}`;
        return undefined;
      },
      timeoutDetail: grade => grade?.checks.filter(check => !check.passed).map(check => check.id).join(", "),
    });
    await saveEvidence();
    const savedTask = observation.tasks[0]!;
    const savedDocuments = observation.documents.map(document => ({ id: document.id, body: document.body, revision: document.latestRevisionId }));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
    await pollUntil({ label: "chat result survives browser reload", deadlineAt: Date.now() + 30_000, load: refresh, accept: grade => grade.passed });
    expect(observation.tasks[0]!.id).toBe(savedTask.id);
    expect(observation.documents.map(document => ({ id: document.id, body: document.body, revision: document.latestRevisionId }))).toEqual(savedDocuments);
    const targetLink = observation.renderedLinks.find(link => linksFeatureTask(link.href, savedTask))!;
    const sourceUrl = page.url();
    const reply = page.locator(`[id=${JSON.stringify(`comment-${targetLink.commentId}`)}]`);
    await expect(reply).toBeVisible();
    const linkIndex = await reply.locator("a[href]").evaluateAll((elements, target) => elements.findIndex(element =>
      new URL(element.getAttribute("href")!, target.base).href === new URL(target.href, target.base).href),
    { base: api.baseURL, href: targetLink.href });
    expect(linkIndex).toBeGreaterThanOrEqual(0);
    await reply.locator("a[href]").nth(linkIndex).click();
    await expect(page.getByTestId("issue-detail-header").getByRole("heading", { name: savedTask.title, exact: true })).toBeVisible();
    expect((await api.get<FeatureTask>(`/api/issues/${encodeURIComponent(savedTask.identifier ?? savedTask.id)}`)).id).toBe(savedTask.id);
    await page.goto(sourceUrl, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
    await input.capture("final-state", "Created task and retained source conversation", "final-state.png");
    input.check?.("browser-result-access", true, "The exact linked task loaded in the browser and the source conversation survived reload.");
    return { issue: observation.source!, runs: chatFeatureExecutionRuns(observation) };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await refresh();
      await saveEvidence();
      const runEvidence = await Promise.all(observation.runs.map(run => collectChatRunEvidence(api, run)));
      await input.evidence("chat-feature-runs.json", runEvidence);
      await input.evidence("api-state.json", { issue: observation.source, runs: observation.runs,
        comments: observation.comments, activity: observation.activity, runEvidence });
    } catch (error) {
      if (!failure) throw error;
      await input.evidence("chat-feature-evidence-error.json", { incomplete: true,
        message: error instanceof Error ? error.message : "Evidence collection failed" });
    } finally {
      try {
        for (const check of gradeChatFeature(observation).checks) input.check?.(check.id, check.passed, check.detail);
      } finally { await fixtures.teardown(); }
    }
  }
}
