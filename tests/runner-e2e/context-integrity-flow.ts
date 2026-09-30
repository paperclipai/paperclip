import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { contextIntegrityScenario } from "./context-integrity-cases.js";
import { gradeContextIntegrity, type ContextIntegrityCheckpoint } from "./context-integrity-scoring.js";
import { pollUntil, type RunnerApi } from "./api.js";
import { createTaskThroughUi } from "./user-actions.js";
import { release as releaseContextCommentGate, waitUntilHeld } from "./context-comment-gate.js";
import { captureLoadedContinuation } from "./continuation-screenshot.js";
import { emitContextIntegrityFinalEvidence } from "./context-integrity-evidence.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";

type Row = Record<string, any>;

export type ContextIntegrityRunLogEvidence =
  | { status: "available"; content: unknown }
  | { status: "unavailable"; reason: "not_found"; statusCode: 404 };

/** A run can be visible before its log file exists; only that 404 is optional. */
export async function readContextIntegrityRunLog(
  api: Pick<RunnerApi, "request">,
  runId: string,
): Promise<ContextIntegrityRunLogEvidence> {
  const response = await api.request.get(
    `/api/heartbeat-runs/${runId}/log?limitBytes=1048576`,
  );
  if (response.status() === 404) {
    return { status: "unavailable", reason: "not_found", statusCode: 404 };
  }
  if (!response.ok()) {
    throw new Error(`Run ${runId} log returned ${response.status()}`);
  }
  return { status: "available", content: await response.json() };
}


function containsSkillReference(value: unknown, runtimeName: string): boolean {
  if (typeof value === "string") {
    return value === runtimeName || value === `/${runtimeName}` || value === `$${runtimeName}` ||
      value.includes(`/${runtimeName}/SKILL.md`);
  }
  if (Array.isArray(value)) return value.some((entry) => containsSkillReference(entry, runtimeName));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, entry]) =>
    /^(skill|skillInput|skillInputs|skillName|toolCall|toolInput|input|arguments|params|path|filePath|name|resource|resources)$/i.test(key) &&
    containsSkillReference(entry, runtimeName),
  );
}

function containsExplicitSkillInput(value: unknown, runtimeName: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsExplicitSkillInput(entry, runtimeName));
  const row = value as Record<string, unknown>;
  const eventKind = [row.eventType, row.kind, row.type, row.name]
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.toLowerCase());
  const nested = [row.payload, row.data, row.event, row.item, row.prpEvent]
    .some((entry) => containsExplicitSkillInput(entry, runtimeName));
  const isSkillEvent = eventKind.some((kind) => /skill|resource_loaded/.test(kind));
  const isReadOrToolEvent = eventKind.some((kind) =>
    /tool_call|tool_started|tool_completed|file_read|file_read_completed/.test(kind),
  );
  return nested ||
    (isSkillEvent && containsSkillReference(row, runtimeName)) ||
    (isReadOrToolEvent && containsSkillReference({
      input: row.input,
      arguments: row.arguments,
      params: row.params,
      toolCall: row.toolCall,
      toolInput: row.toolInput,
      path: row.path,
      filePath: row.filePath,
      name: row.name,
    }, runtimeName));
}

export async function runContextIntegrityFlow(input: {
  page: Page;
  api: RunnerApi;
  fixtures: LiveFixtureValues;
  execution: MatrixExecution;
  nonce: string;
  deadlineAt: number;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, value: unknown): Promise<void>;
  observe(issue: Row, runs: Row[], checks: ReturnType<typeof gradeContextIntegrity>): void;
}) {
  const { page, api, fixtures, execution, nonce } = input;
  const scenario = contextIntegrityScenario(execution.task.id, nonce) as ReturnType<typeof contextIntegrityScenario> & {
    assignedSkill?: { key: string; runtimeName: string; markdown: string };
  };
  const companyPath = `/api/companies/${fixtures.company.id}`;
  const budgetGuard = {
    companyMonthlyCents: 1_000,
    agentMonthlyCents: 1_000,
    currency: "USD",
    hardStop: true,
  } as const;
  let issue: Row | undefined;
  let runs: Row[] = [];
  let skillRequestText = "";
  let assignedVersionId: string | null = null;
  const checkpoints: ContextIntegrityCheckpoint[] = [];

  if (scenario.id === "assigned-skill-explicit-invocation") {
    await api.patch("/api/instance/settings/experimental", { enableBetaSkills: true });
    const markdown = `---\nname: ${scenario.skillKey}\ndescription: Context integrity output procedure.\n---\n\n# Context integrity output procedure\n\nWrite exactly one task document whose body contains the marker ${scenario.marker}. Finish the task after saving that document.`;
    if (!markdown.startsWith(`---\nname: ${scenario.skillKey}\ndescription:`) || markdown.includes("\\n")) {
      throw new Error("Context-integrity skill payload must contain real frontmatter newlines");
    }
    const skill = await api.post<Row>(`${companyPath}/skills`, {
      name: scenario.skillName,
      slug: scenario.skillKey,
      description: "A bounded context-integrity output procedure.",
      markdown,
      idempotencyKey: `context-integrity-${nonce}`,
    });
    await api.post(`/api/agents/${fixtures.agent.id}/skills/sync?companyId=${fixtures.company.id}`, {
      desiredSkills: [{ key: skill.key ?? skill.slug ?? scenario.skillKey, versionId: skill.currentVersionId ?? skill.versionId ?? null }],
      mode: "add",
    });
    const assigned = await api.get<Row>(`/api/agents/${fixtures.agent.id}/skills?companyId=${fixtures.company.id}`);
    const desired = (assigned.desiredSkillEntries as Array<Row> | undefined)?.find((entry) => entry.key === (skill.key ?? skill.slug ?? scenario.skillKey));
    if (!desired?.versionId) throw new Error("Context-integrity skill was not assigned with a pinned version");
    if (String(desired.versionId) !== String(skill.currentVersionId ?? skill.versionId ?? "")) throw new Error("Context-integrity skill assignment does not match the created current version");
    assignedVersionId = String(desired.versionId);
    scenario.assignedSkill = { key: String(skill.key ?? skill.slug ?? scenario.skillKey), runtimeName: String(skill.slug ?? scenario.skillKey), markdown };
  }

  async function refresh() {
    if (!issue) return;
    issue = await api.get<Row>(`/api/issues/${issue.id}`);
    const listed = await api.get<Row[]>(`${companyPath}/heartbeat-runs?limit=100`);
    const detailed = await Promise.all(listed.map((run) => api.get<Row>(`/api/heartbeat-runs/${run.id}`)));
    runs = detailed.filter((run) => run.issueId === issue!.id || run.nativeIssueId === issue!.id || run.contextSnapshot?.issueId === issue!.id || run.contextSnapshot?.taskId === issue!.id);
  }
  async function snapshot(phase: ContextIntegrityCheckpoint["phase"]) {
    await refresh();
    const [comments, documents, skillRows, queuedComments, assignedState] = await Promise.all([
      api.get<Row[]>(`/api/issues/${issue!.id}/comments?order=asc`),
      api.get<Row[]>(`/api/issues/${issue!.id}/documents`),
      api.get<Row[]>(`${companyPath}/skills`),
      api.get<Row>(`/api/issues/${issue!.id}/queued-comments`),
      scenario.id === "assigned-skill-explicit-invocation" ? api.get<Row>(`/api/agents/${fixtures.agent.id}/skills?companyId=${fixtures.company.id}`) : Promise.resolve({} as Row),
    ]);
    const detailedDocuments = await Promise.all(documents.map((document) => api.get<Row>(`/api/issues/${issue!.id}/documents/${encodeURIComponent(String(document.key))}`)));
    const assignedSkill = scenario.id === "assigned-skill-explicit-invocation"
      ? skillRows.find((skill) => skill.key === scenario.assignedSkill?.key || skill.slug === scenario.assignedSkill?.key)
      : undefined;
    const desiredSkill = (assignedState.desiredSkillEntries as Array<Row> | undefined)?.find((entry) => entry.key === scenario.assignedSkill?.key);
    const runEvents = await Promise.all(runs.map((run) => api.get<Row[]>(`/api/heartbeat-runs/${run.id}/events?limit=1000`)));
    const runLogs = await Promise.all(runs.map((run) => readContextIntegrityRunLog(api, run.id)));
    const skillInvocationEvidence = scenario.id === "assigned-skill-explicit-invocation" && runEvents.some((events) => events.some((event) => containsExplicitSkillInput(event, String(assignedSkill?.slug ?? scenario.skillKey))));
    skillRequestText = scenario.id === "assigned-skill-explicit-invocation" ? String(issue?.description ?? "") : "";
    checkpoints.push({ phase, issue: { id: issue!.id, status: String(issue!.status) }, comments, queuedComments, documents: detailedDocuments as Array<{ key: string; body?: string | null }>, runs, runEvents: runEvents.flat(), runLogs, assignedSkill: assignedSkill ? { key: String(desiredSkill?.key ?? assignedSkill.key ?? assignedSkill.slug), runtimeName: String(assignedSkill.slug ?? ""), versionId: desiredSkill?.versionId === assignedVersionId ? assignedVersionId : null, markdown: String(assignedSkill.markdown ?? scenario.assignedSkill?.markdown ?? "") } : undefined, skillRequestText: scenario.id === "assigned-skill-explicit-invocation" ? skillRequestText : undefined, skillInvocationEvidence });
    const checks = gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints });
    input.observe(issue!, runs, checks);
    await input.evidence("context-integrity.json", { schema: "paperclip.context-integrity.v1", scenario, budgetGuard, checkpoints, checks });
  }
  async function settle(before: Set<string>) {
    await pollUntil({
      label: `context-integrity ${scenario.id} settled`,
      deadlineAt: input.deadlineAt,
      load: async () => { await refresh(); return { issue, runs }; },
      accept: (state) => state.runs.some((run) => !before.has(run.id) && ["succeeded", "failed", "timed_out", "cancelled"].includes(run.status)) && state.runs.filter((run) => !before.has(run.id)).every((run) => ["succeeded", "failed", "timed_out", "cancelled"].includes(run.status)),
      reject: (state) => state.runs.some((run) => !before.has(run.id) && ["failed", "timed_out", "cancelled"].includes(run.status)) ? "provider run failed" : undefined,
      intervalMs: 1_000,
    });
  }
  try {
    await api.patch("/api/instance/settings/experimental", { enableClassicTaskInterface: false });
    await api.patch(`/api/companies/${fixtures.company.id}/budgets`, {
      budgetMonthlyCents: budgetGuard.companyMonthlyCents,
    });
    await api.patch(`/api/agents/${fixtures.agent.id}/budgets`, {
      budgetMonthlyCents: budgetGuard.agentMonthlyCents,
    });
    const taskPrompt = scenario.id === "assigned-skill-explicit-invocation"
      ? `${scenario.prompt}\n\nUse /${scenario.skillKey} for this request.`
      : scenario.prompt;
    skillRequestText = taskPrompt;
    await createTaskThroughUi({ page, issuePrefix: fixtures.company.issuePrefix!, agentName: fixtures.agent.name, title: execution.task.buildTitle(nonce), prompt: taskPrompt, workMode: "standard" });
    issue = await pollUntil({ label: "context-integrity task created", deadlineAt: input.deadlineAt, load: async () => (await api.get<Row[]>(`${companyPath}/issues?limit=100`)).find((row) => row.title === execution.task.buildTitle(nonce)), accept: Boolean });
    if (!issue) throw new Error("Missing context-integrity task");
    if (scenario.id === "ordered-comment-continuation") {
      await pollUntil({
        label: "context-integrity initial run started",
        deadlineAt: input.deadlineAt,
        load: async () => { await refresh(); return runs; },
        accept: (currentRuns) => currentRuns.some((run) => run.status === "running" && (run.issueId === issue!.id || run.nativeIssueId === issue!.id || run.contextSnapshot?.issueId === issue!.id || run.contextSnapshot?.taskId === issue!.id)),
      });
      await waitUntilHeld(issue.id, input.deadlineAt);
      let gateReleased = false;
      try {
        await snapshot("initial");
        const initialCheckpoint = checkpoints.at(-1);
        if (!initialCheckpoint?.runs.some((run) => run.status === "running") || initialCheckpoint.documents.length === 0) {
          throw new Error("Context-integrity gate did not expose a running initial run with a committed document");
        }
        const initialRunIds = new Set(runs.map((run) => run.id));
        for (let index = 0; index < scenario.comments.length; index += 1) {
          await api.post(`/api/issues/${issue.id}/comments`, { body: scenario.comments[index], clientRequestId: randomUUID() });
        }
        await snapshot("comment-3");
        const queuedEntries = checkpoints.at(-1)?.queuedComments?.entries;
        const queuedRows = Array.isArray(queuedEntries) ? queuedEntries.map((entry) => {
          const comment = (entry as Row).comment as Row | undefined;
          return { id: String(comment?.id ?? ""), body: String(comment?.body ?? "") };
        }) : [];
        if (queuedRows.length < scenario.comments.length || scenario.comments.some((body, index) => queuedRows[index]?.body !== body) || queuedRows.slice(0, scenario.comments.length).some((row) => !row.id) || new Set(queuedRows.slice(0, scenario.comments.length).map((row) => row.id)).size !== scenario.comments.length) {
          throw new Error("Context-integrity comment gate observed an incomplete or reordered deferred queue");
        }
        await releaseContextCommentGate(issue.id);
        gateReleased = true;
        await settle(initialRunIds);
      } finally {
        if (!gateReleased) await releaseContextCommentGate(issue.id);
      }
    } else {
      await settle(new Set());
      await snapshot("initial");
    }
    await snapshot("final");
    const checks = gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints });
    const failures = checks.filter((check) => !check.passed);
    if (failures.length) throw new Error(`Context-integrity matcher failures: ${failures.map((failure) => `${failure.id}: ${failure.detail}`).join("; ")}`);
    await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await captureLoadedContinuation(page, String(issue.title), () => emitContextIntegrityFinalEvidence({ evidence: input.evidence, capture: input.capture, issue, runs, checkpoints, checks, runEvents: checkpoints.at(-1)?.runEvents, runLogs: checkpoints.at(-1)?.runLogs }));
    return { issue, runs, checks };
  } finally {
    const checks = gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints });
    if (issue) input.observe(issue, runs, checks);
    await input.evidence("context-integrity.json", { schema: "paperclip.context-integrity.v1", scenario, budgetGuard, checkpoints, checks });
  }
}
