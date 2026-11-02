import { expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pollUntil, type RunnerApi } from "./api.js";
import { collectChatRunEvidence } from "./chat-flow.js";
import { FixtureRegistry } from "./fixture-registry.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";
import { createPlanTaskThroughUi } from "./plan-task-ui.js";
import { PLAN_BASE_SHA, PLAN_BUDGET_CENTS, PLAN_MAX_RUNS, parsePlanCase, planDefinitionDigest, planScenario } from "./plan-task-cases.js";
import { gradePlanTask, type PlanCheck, type PlanDocument, type PlanObservation, type PlanRow } from "./plan-task-scoring.js";
import { planExposure, planInvocationPrompt, planInvocations, type PlanInvocation } from "./plan-task-exposure.js";
import { preparePlanSkills, selectPlanSkills, verifyPlanSelection, verifyPlanSkills } from "./plan-task-skills.js";

type Input = {
  page: Page; api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution;
  nonce: string; workspacePath: string; deadlineAt: number;
  observe(issue: PlanRow, runs: PlanRow[], checks: PlanCheck[]): void;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, value: unknown): Promise<void>;
};

export async function runPlanTaskFlow(input: Input) {
  const { api, page, fixtures: f, execution } = input;
  const { variant, caseId } = parsePlanCase(execution.task.id);
  const scenario = planScenario(caseId, input.nonce);
  const company = `/api/companies/${f.company.id}`;
  const source: PlanRow = { origin: api.baseURL, variant, base: PLAN_BASE_SHA, definitionDigest: planDefinitionDigest, skills: [], agents: [] };
  let parent: PlanRow | undefined, alexId = "", rileyId = "", failure: string | undefined;
  let observed: PlanObservation = { issues: [], runs: [], documents: [], comments: [], activity: [], interactions: [], wakes: [] };
  let checks: PlanCheck[] = [];
  let invocations: PlanInvocation[] = [];
  let runEvidence: PlanRow[] = [];
  const exposure = () => planExposure({ runs: observed.runs, evidence: runEvidence, leadId: f.agent.id, parentId: parent?.id ?? "", invocations });
  async function captureRuns() {
    runEvidence = await Promise.all(observed.runs.map(run => collectChatRunEvidence(api, run as Parameters<typeof collectChatRunEvidence>[1])
      .catch(error => ({ runId: run.id, evidenceError: String(error) }))));
  }
  const grade = () => gradePlanTask({ caseId, marker: scenario.marker, parentId: parent?.id ?? "", leadId: f.agent.id,
    alexId, rileyId, observation: observed, maxRuns: PLAN_MAX_RUNS, origin: api.baseURL });

  async function observe() {
    const [issues, list] = await Promise.all([api.get<PlanRow[]>(`${company}/issues`), api.get<PlanRow[]>(`${company}/heartbeat-runs?limit=100`)]);
    if (list.length >= 100) throw new Error("Company run list is truncated; cannot qualify accounting");
    const runs = await Promise.all(list.map(run => api.get<PlanRow>(`/api/heartbeat-runs/${run.id}`)));
    const details = await Promise.all(issues.map(async issue => {
      const base = `/api/issues/${issue.id}`;
      const [full, docs, comments, activity, interactions, wakes] = await Promise.all([
        api.get<PlanRow>(base), api.get<PlanRow[]>(`${base}/documents`), api.get<PlanRow[]>(`${base}/comments?order=asc`),
        api.get<PlanRow[]>(`${base}/activity`), api.get<PlanRow[]>(`${base}/interactions`), api.get<PlanRow>(`${base}/diagnostics/wakes`),
      ]);
      const documents = await Promise.all(docs.map(async doc => ({ ...doc, issueId: issue.id,
        revisions: await api.get<PlanRow[]>(`${base}/documents/${encodeURIComponent(doc.key)}/revisions`) } as PlanDocument)));
      return { full, documents, comments, activity, interactions, wakes: { ...wakes, issueId: issue.id } };
    }));
    observed = { issues: details.map(d => d.full), runs, documents: details.flatMap(d => d.documents),
      comments: details.flatMap(d => d.comments), activity: details.flatMap(d => d.activity),
      interactions: details.flatMap(d => d.interactions), wakes: details.map(d => d.wakes) };
    if (parent) { parent = observed.issues.find(i => i.id === parent!.id) ?? parent; input.observe(parent, runs, checks); }
    return observed;
  }

  try {
    // Public fixture APIs and normal skill versioning only. No provider begins
    // until the served bytes and all three agents' selections are verified.
    await api.patch(`${company}/budgets`, { budgetMonthlyCents: PLAN_BUDGET_CENTS });
    source.skills = await preparePlanSkills(api, f.company.id, variant);
    const registry = new FixtureRegistry();
    for (const [id, name, role, capabilities] of [
      ["alex", "Alex Metrics", "engineer", "Owns arithmetic verification, operational metrics, and signed order summaries."],
      ["riley", "Riley Copy", "qa", "Owns publication copy, release verification and independent arithmetic audits."],
    ] as const) {
      registry.register<PlanRow>({ id, async setup() {
        const workspacePath = path.join(input.workspacePath, id);
        await mkdir(workspacePath, { recursive: true });
        const payload = execution.profile.buildAgent({ environmentId: f.environment.id, environmentFixtureId: "local",
          workspacePath, secretRefs: f.secretRefs, executionId: input.nonce });
        return api.post(`${company}/agents`, { ...payload, name, role, title: name, capabilities, reportsTo: f.agent.id,
          instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": `You are ${name}. ${capabilities} Deliver accurate work that meets your assignment.` } } });
      } });
    }
    const team = await registry.setupAll();
    alexId = (team.values.get("alex") as PlanRow).id;
    rileyId = (team.values.get("riley") as PlanRow).id;
    for (const id of [f.agent.id, alexId, rileyId]) {
      await api.patch(`/api/agents/${id}/permissions`, { canCreateAgents: false, canAssignTasks: id === f.agent.id });
      await api.patch(`/api/agents/${id}/budgets`, { budgetMonthlyCents: PLAN_BUDGET_CENTS });
      const skills = await selectPlanSkills(api, f.company.id, id, source.skills);
      source.agents.push({ id, skills });
      if (id === f.agent.id) invocations = planInvocations(source.skills, skills);
    }
    source.invocations = invocations;
    source.requestPrompt = planInvocationPrompt(scenario.prompt, invocations);
    await input.evidence("plan-task-source.json", source);
    await api.patch("/api/instance/settings/experimental", { enableClassicTaskInterface: false });
    const created = await createPlanTaskThroughUi({ page, companyId: f.company.id, issuePrefix: f.company.issuePrefix!,
      agentName: f.agent.name, prompt: source.requestPrompt });
    parent = await pollUntil({ label: "browser-created planning-guidance task", deadlineAt: input.deadlineAt,
      load: () => api.get<PlanRow>(`/api/issues/${created.id}`), accept: i => i.id === created.id });
    if (!parent) throw new Error("Browser task not found");
    let previous = "", same = 0;
    await pollUntil({ label: "planning work and handoffs settle", deadlineAt: input.deadlineAt, intervalMs: 1_500, load: observe,
      accept: o => {
        const idle = o.runs.length > 0 && o.runs.every(r => ["succeeded", "failed", "timed_out", "cancelled"].includes(r.status));
        const done = o.issues.length > 0 && o.issues.every(i => i.status === "done" && !i.scheduledRetry && !i.activeRecoveryAction);
        const signature = idle && done ? JSON.stringify(o) : "";
        same = signature && signature === previous ? same + 1 : 0; previous = signature;
        return same >= 2;
      }, reject: o => o.runs.length > PLAN_MAX_RUNS ? "bounded run count exceeded" :
        o.runs.some(r => ["failed", "timed_out", "cancelled"].includes(r.status)) ? "actual run failed; retain original failure" : undefined });
    await verifyPlanSkills(api, f.company.id, source.skills);
    for (const id of [f.agent.id, alexId, rileyId]) await verifyPlanSelection(api, f.company.id, id, source.skills);
    await captureRuns();
    checks = [...grade().checks, exposure()];
    input.observe(parent, observed.runs, checks);
    await page.goto(`/${f.company.issuePrefix}/issues/${parent.identifier ?? parent.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: parent.title, exact: true })).toBeVisible();
    await expect(page.getByTestId("issue-chat-skeleton")).toHaveCount(0);
    await input.capture("final-state", "Saved planning outcome and task graph", "final-state.png");
    if (checks.some(c => !c.passed)) throw new Error(`Planning outcome failed: ${checks.filter(c => !c.passed).map(c => c.id).join(", ")}`);
    return { issue: parent, runs: observed.runs, checks };
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    checks = [...grade().checks, exposure(), { id: "workflow-completed", passed: false, detail: failure }];
    if (parent) input.observe(parent, observed.runs, checks);
    throw error;
  } finally {
    let captureError: string | undefined;
    try { await observe(); } catch (error) { captureError = String(error); }
    const finalSkills = await Promise.all([f.agent.id, alexId, rileyId].filter(Boolean).map(async id => ({ id,
      skills: await api.get(`/api/agents/${id}/skills?companyId=${f.company.id}`).catch(error => ({ error: String(error) })) })));
    await captureRuns();
    await input.evidence("plan-task-runs.json", runEvidence);
    await input.evidence("plan-task-guidance.json", { variant, caseId, scenario, source, finalSkills, parentId: parent?.id,
      leadId: f.agent.id, alexId, rileyId, budgetCents: PLAN_BUDGET_CENTS, maxRuns: PLAN_MAX_RUNS,
      observation: observed, result: grade(), exposure: exposure(), failure, captureError });
    await input.evidence("api-state.json", { capturePhase: "plan-task-final", issue: parent, runs: observed.runs, checks, failure, captureError });
  }
}
