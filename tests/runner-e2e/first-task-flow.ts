import { runsCompletionUpdateProbe } from "./completion-quality.js";
import { gradeConfirmationReply, assertConfirmationReceipt } from "./confirmation-replies.js";
import { firstTaskUserRequest } from "./first-task-transcript.js";
import { isBlockedUnstartedWake, isTerminalUnstartedWake } from "./non-execution-wake.js";
import { firstTaskRejectionReplyRecorded, isFirstTaskRejectionCancellation } from "./first-task-rejection.js";
import { answerableRuntimeRunIds } from "./runtime-question-readiness.js";
import { captureFirstTaskAttachments } from "./first-task-attachments.js";
import { waitForFirstTaskReply } from "./first-task-replies.js";
import { observeCompletionUpdate } from "./completion-update-flow.js";
import {
  firstTaskNativeRuntimePatch,
  provisionFirstTaskFixtures,
} from "./first-task-fixtures.js";
import { execFileSync } from "node:child_process";
import { expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { pollUntil, type RunnerApi } from "./api.js";
import {
  sendChatMessage,
  chatQuestionPresentation,
  collectChatRunEvidence,
} from "./chat-flow.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { CredentialName, MatrixExecution, RunnerE2EResult } from "./types.js";
import { firstTaskScenario } from "./first-task-cases.js";
import {
  activeRuns,
  digestText,
  snapshotInstruction,
  gradeFirstTask,
  firstTaskCompletionSettled,
  type FirstTaskEvidence,
  type FirstTaskCheckpoint,
  type Row,
} from "./first-task-scoring.js";

/** Results enter the public history bundle. Full observations stay in the
 * access-controlled snapshots and are graded before this projection. */
export function projectFirstTaskResult(result: RunnerE2EResult): RunnerE2EResult {
  const e = result.firstTask;
  if (!e) return result;
  const pick = (value: unknown, fields: readonly string[]): Row => {
    const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return Object.fromEntries(fields.flatMap(key => {
      const item = row[key];
      return item === null || ["string", "number", "boolean"].includes(typeof item)
        ? [[key, item]] : [];
    })) as Row;
  };
  const rows = (value: unknown): Row[] => Array.isArray(value)
    ? value.filter(row => row && typeof row === "object") : [];
  const strings = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string") : [];
  const usage = (value: unknown) => {
    const u = value as Row | undefined;
    const measurements = ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens", "cacheReadTokens", "cachedReadTokens", "input", "output", "promptTokens", "completionTokens", "cacheAdjustedCostUsd", "costUsd", "providerCostUsd", "costUsdExact"];
    return {
      ...pick(u, [...measurements, "model", "provider", "biller", "billingType", "costStatus", "usageSource", "accountingReceiptReady"]),
      ...Object.fromEntries(["runDelta", "total", "cumulative"].filter(key => u?.[key]).map(key => [key, pick(u?.[key], measurements)])),
      ...(u?.cost ? { cost: pick(u.cost, ["currency", "amount", "total"]) } : {}),
      ...(u?.pricingProvenance ? { pricingProvenance: pick(u.pricingProvenance, ["source", "version", "contextTier", "serviceTier", "inputCentsPerMillion", "outputCentsPerMillion", "cacheWriteCentsPerMillion", "cachedInputCentsPerMillion"]) } : {}),
    };
  };
  const questionSet = (value: unknown) => {
    const set = value as Row | undefined;
    return { ...pick(set, ["title", "description", "submitLabel"]), questions: rows(set?.questions).map(q => ({
      ...pick(q, ["id", "prompt", "header", "helpText", "required", "answerMode", "selectionMode", "allowOther"]),
      options: rows(q.options).map(option => pick(option, ["id", "label", "description", "recommended", "freeText"])),
      ...(q.customAnswer ? { customAnswer: pick(q.customAnswer, ["enabled", "label", "placeholder"]) } : {}),
    })) };
  };
  const interaction = (row: Row): Row => {
    const payload = row.payload as Row | undefined;
    const answers = row.result?.answers;
    const answerRows: Row[] = Array.isArray(answers) ? rows(answers) : answers && typeof answers === "object"
      ? Object.entries(answers).map(([questionId, answer]) => ({ ...answer as Row, questionId })) : [];
    return {
      ...pick(row, ["id", "issueId", "kind", "status", "createdAt", "resolvedAt", "resolvedByAgentId"]),
      ...(row.resolvedByUserId ? { resolvedByUserId: "fixture-board" } : {}),
      payload: {
        ...pick(payload, ["version", "title", "prompt", "detailsMarkdown", "acceptLabel", "rejectLabel", "rejectRequiresReason", "rejectReasonLabel", "submitLabel"]),
        ...(payload?.questions ? questionSet(payload) : {}),
        ...(payload?.questionSet ? { questionSet: questionSet(payload.questionSet) } : {}),
        ...(payload?.target ? { target: pick(payload.target, ["type", "key", "label", "revisionNumber"]) } : {}),
      },
      ...(row.result ? { result: {
        ...pick(row.result, ["outcome", "reason", "commentId"]),
        answers: answerRows.map(answer => ({
          ...pick(answer, ["id", "questionId", "text", "otherText", "customText"]),
          optionIds: strings(answer.optionIds ?? answer.selectedOptionIds),
        })),
      } } : {}),
    };
  };
  const privateInstructions = "Full instructions are retained in the access-controlled first-task snapshot.";
  const settings = e.runtimeSettings as Record<string, any> | undefined;
  const checkpointIds = new Set(e.checkpoints.map(c => c.id));
  const firstTask: FirstTaskEvidence = {
    caseId: e.caseId, nonce: e.nonce, onboardingIssueId: e.onboardingIssueId,
    agentId: e.agentId, initialTaskIds: [...e.initialTaskIds],
    ...(e.source ? { source: { sha: e.source.sha, ref: e.source.ref, dirty: e.source.dirty } } : {}),
    configuredModel: e.configuredModel, observedModels: [...e.observedModels],
    instructions: e.instructions.map(i => ({
      path: /^(?:\/|[A-Za-z]:)|(?:^|\/)\.\.(?:\/|$)/.test(i.path) ? "private-instruction-path" : i.path,
      sha256: i.sha256, content: privateInstructions, contentSha256: digestText(privateInstructions), redacted: true,
    })),
    runtimeSettings: {
      ...pick(settings, ["adapterType", "completionDeliveryProbe"]),
      adapterConfig: pick(settings?.adapterConfig, ["provider", "model", "modelReasoningEffort", "lifecycleMode", "codexPermissionMode"]),
      ...(settings?.onboardingRuntime ? { onboardingRuntime: pick(settings.onboardingRuntime, ["mode", "originalAdapterType", "testedAdapterType", "originalModel"]) } : {}),
    },
    checkpoints: e.checkpoints.map(c => ({
      id: c.id, at: c.at, phase: c.phase, issueId: c.issueId,
      tasks: c.tasks.map(t => pick(t, ["id", "identifier", "title", "description", "status", "parentId", "assigneeAgentId", "createdAt", "completedAt"])),
      agents: c.agents.map(a => ({ ...pick(a, ["id", "name", "adapterType"]),
        adapterConfig: pick(a.adapterConfig, ["provider", "model", "modelReasoningEffort", "lifecycleMode", "codexPermissionMode"]) })),
      comments: c.comments.map(comment => ({ ...pick(comment, ["id", "issueId", "body", "authorAgentId", "createdAt"]),
        ...(comment.authorUserId ? { authorUserId: "fixture-board" } : {}) })),
      interactions: c.interactions.map(interaction),
      documents: c.documents.map(d => pick(d, ["id", "issueId", "key", "title", "body", "format", "latestRevisionId", "latestRevisionNumber", "createdAt", "updatedAt"])),
      attachments: (c.attachments ?? []).map(a => pick(a, ["id", "issueId", "title", "originalFilename", "filename", "body", "contentVerified", "contentSha256", "byteSize", "createdAt"])),
      runs: c.runs.map(run => ({ ...pick(run, ["id", "issueId", "status", "startedAt", "finishedAt", "runtimeMode", "driverKind"]),
        ...pick({ model: run.resultJson?.model ?? run.usageJson?.model }, ["model"]) })),
    })),
    checks: e.checks.map(check => ({
      id: check.id, passed: check.passed,
      ...(check.notReached ? { notReached: "The journey did not reach this check; private evidence retains the reason." } : {}),
      evidence: check.evidence.filter(ref => checkpointIds.has(ref)),
      detail: `${check.id}: ${check.notReached ? "not reached" : check.passed ? "passed" : "failed"}. Full diagnostic evidence is retained in the access-controlled snapshot.`,
    })),
  };
  return {
    ...result, firstTask,
    ...(result.usage ? { usage: Array.isArray(result.usage.runs)
      ? { runs: rows(result.usage.runs).map(run => ({ runId: run.runId, usage: run.usage ? usage(run.usage) : null })) }
      : usage(result.usage) } : {}),
    ...(result.error ? { error: "First-task journey failed; inspect the recorded checks and access-controlled evidence for the original error." } : {}),
    matcherResults: (result.matcherResults ?? []).map(matcher => ({
      ...matcher,
      detail: matcher.matcher.kind === "json_path"
        ? firstTask.checks.find(check => matcher.matcher.kind === "json_path" && matcher.matcher.path === `firstTask.checks.${check.id}`)?.detail
          ?? `${matcher.matcher.kind}: ${matcher.passed ? "passed" : "failed"}. Private evidence retains diagnostics.`
        : `${matcher.matcher.kind}: ${matcher.passed ? "passed" : "failed"}. Private evidence retains diagnostics.`,
    })),
  };
}

/** The wizard creates the agent/task. Only credential provisioning uses Node fetch,
 * keeping plaintext keys out of Playwright's trace and recorded form values. */
export async function setupFirstTaskFixtures(input: {
  page: Page;
  api: RunnerApi;
  execution: MatrixExecution;
  nonce: string;
  credentials: Partial<Record<CredentialName, string>>;
  observe: (fixtures: LiveFixtureValues) => void;
}): Promise<LiveFixtureValues> {
  const { page, api, execution, nonce } = input;
  await api.patch("/api/instance/settings/experimental", {
    enableClassicTaskInterface: false,
  });
  await page.goto("/onboarding", { waitUntil: "domcontentloaded" });
  const launcher = page.getByRole("button", {
    name: /Start Onboarding|New Organization|Add Agent/,
  });
  if (await launcher.count()) await launcher.first().click();
  const create = page.getByRole("button", { name: /Build a new organization/ });
  if (await create.count()) await create.first().click();
  await page
    .getByPlaceholder("e.g. Northwind Labs")
    .fill(`First task ${nonce}`);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator("#onboarding-agent-name")).toBeVisible();
  const companies = await api.get<Row[]>("/api/companies");
  const company = companies.find((c) => c.name === `First task ${nonce}`);
  if (!company) throw new Error("Onboarding fixture company missing");
  const fixtures = await provisionFirstTaskFixtures({
    api,
    execution,
    nonce,
    credentials: input.credentials,
    company: {
      id: company.id,
      name: company.name,
      issuePrefix: company.issuePrefix,
    },
  });
  const secret = fixtures.secretRefs[execution.profile.credential]!;
  input.observe(fixtures);
  await page.locator("#onboarding-agent-name").fill(fixtures.agent.name);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Connect a model" }),
  ).toBeVisible();
  await page
    .getByRole("radio", {
      name:
        execution.profile.credential === "OPENAI_API_KEY"
          ? /^OpenAI/
          : /^Claude/,
    })
    .click();
  const useKey = page.getByRole("button", {
    name: "Use API key instead",
    exact: true,
  });
  const savedKey = page.getByRole("combobox", { name: "Saved API key" });
  if (execution.profile.id === "legacy-codex") {
    await page.getByText("Advanced", { exact: true }).click();
    await page.getByRole("button", { name: "Runner", exact: true }).click();
    await page.getByRole("option", { name: "Legacy runner", exact: true }).click();
  }
  // Credential mode depends on the selected provider and its asynchronous key lookup.
  await expect(savedKey.or(useKey).first()).toBeVisible();
  if (await useKey.isVisible()) await useKey.click();
  await page
    .getByRole("combobox", { name: "Saved API key" })
    .selectOption(`company:${secret.secretId}`);
  await page
    .getByRole("button", { name: /^(Connect|Next)$/, exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("button", { name: "Get started", exact: true }),
  ).toBeVisible({ timeout: 120_000 });
  const agents = await api.get<Row[]>(`/api/companies/${company.id}/agents`);
  expect(agents).toHaveLength(1);
  const wizardAdapter =
    execution.profile.credential === "OPENAI_API_KEY"
      ? execution.profile.id === "runner-codex" ? "paperclip_runner" : "codex_local"
      : "claude_local";
  expect(agents[0].adapterType).toBe(wizardAdapter);
  if (execution.profile.id === "runner-codex") {
    expect(agents[0].adapterConfig?.provider).toBe("codex");
  }
  fixtures.onboardingRuntime = {
    mode: "production-wizard",
    originalAdapterType: wizardAdapter,
    testedAdapterType: wizardAdapter,
    originalModel: agents[0].adapterConfig?.model ?? null,
  };
  // Claude remains an explicit native regression path in this Codex-only
  // rollout. Codex is never switched after onboarding: the saved default is
  // the execution under test.
  if (execution.profile.id === "runner-acpx-claude") {
    const runtimePatch = firstTaskNativeRuntimePatch(
      execution,
      fixtures,
      agents[0],
    );
    const migrated = await api.patch<Row>(
      `/api/agents/${agents[0].id}`,
      runtimePatch,
    );
    expect(migrated.adapterType).toBe("paperclip_runner");
    expect(migrated.adapterConfig?.provider).toBe(execution.profile.provider);
    expect(migrated.adapterConfig?.instructionsFilePath).toBe(
      agents[0].adapterConfig?.instructionsFilePath,
    );
    expect(migrated.adapterConfig?.paperclipSkillSync?.desiredSkills).toEqual(
      (
        runtimePatch.adapterConfig.paperclipSkillSync as {
          desiredSkills?: unknown[];
        }
      )?.desiredSkills,
    );
    fixtures.onboardingRuntime = {
      mode: "post-onboarding-runtime-switch",
      originalAdapterType: wizardAdapter,
      testedAdapterType: migrated.adapterType,
      originalModel: agents[0].adapterConfig?.model ?? null,
    };
  }
  fixtures.agent = {
    id: agents[0].id,
    companyId: company.id,
    name: agents[0].name,
  };
  input.observe(fixtures);
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  return fixtures;
}

export async function runFirstTaskFlow(input: {
  page: Page;
  api: RunnerApi;
  fixtures: LiveFixtureValues;
  execution: MatrixExecution;
  nonce: string;
  observe: (issue: any, runs: any[], evidence: FirstTaskEvidence) => void;
  secrets: readonly string[];
  createOrdinary: (title: string, prompt: string) => Promise<Row>;
  capture: (id: string, label: string, file: string) => Promise<void>;
  evidence: (name: string, value: unknown) => Promise<void>;
}) {
  const { page, api, fixtures, execution, nonce } = input;
  const scenario = firstTaskScenario(execution.task.id, nonce);
  const deadlineAt =
    Date.now() + execution.task.attemptTimeoutMs.local - 120_000;
  const tasksPath = `/api/companies/${fixtures.company.id}/issues?limit=100`;
  const allRuns = async () => {
    const runs = await api.get<Row[]>(
      `/api/companies/${fixtures.company.id}/heartbeat-runs?limit=100`,
    );
    return Promise.all(
      runs.map((r) => api.get<Row>(`/api/heartbeat-runs/${r.id}`)),
    );
  };
  const initial = await pollUntil({
    label: "onboarding first task",
    deadlineAt,
    load: () => api.get<Row[]>(tasksPath),
    accept: (rows) => rows.length === 1,
  });
  let issue = initial[0];
  expect(issue.assigneeAgentId).toBe(fixtures.agent.id);
  expect(issue.description).toContain("/first-task");
  expect(await allRuns()).toHaveLength(0);
  const e: FirstTaskEvidence = {
    caseId: scenario.id,
    nonce,
    onboardingIssueId: issue.id,
    agentId: fixtures.agent.id,
    initialTaskIds: initial.map((t) => t.id),
    instructions: [],
    configuredModel: null,
    observedModels: [],
    checkpoints: [],
    checks: [],
  };
  input.observe(issue, [], e);
  const snapshot = async (
    phase: FirstTaskCheckpoint["phase"],
    at = new Date().toISOString(),
  ) => {
    const [tasks, agents, comments, interactions, runs] = await Promise.all([
      api.get<Row[]>(tasksPath),
      api.get<Row[]>(`/api/companies/${fixtures.company.id}/agents`),
      api.get<Row[]>(`/api/issues/${issue.id}/comments?order=asc`),
      api.get<Row[]>(`/api/issues/${issue.id}/interactions`),
      allRuns(),
    ]);
    const documents = (
      await Promise.all(
        tasks.map(async (t) => {
          const summaries = await api.get<Row[]>(
            `/api/issues/${t.id}/documents`,
          );
          return Promise.all(
            summaries.map(async (d) => ({
              ...(await api.get<Row>(
                `/api/issues/${t.id}/documents/${encodeURIComponent(d.key)}`,
              )),
              key: d.key,
              issueId: t.id,
            })),
          );
        }),
      )
    ).flat();
    issue = tasks.find((t) => t.id === issue.id) ?? issue;
    e.observedModels = [
      ...new Set(
        runs
          .map((r) => r.resultJson?.model ?? r.usageJson?.model)
          .filter((m): m is string => typeof m === "string"),
      ),
    ];
    const checkpoint: FirstTaskCheckpoint = {
      id: `${phase}-${e.checkpoints.length}`,
      at,
      phase,
      issueId: issue.id,
      tasks,
      agents,
      comments,
      interactions,
      documents,
      attachments: await captureFirstTaskAttachments(api, tasks, input.secrets),
      runs,
    };
    e.checkpoints.push(checkpoint);
    e.checks = gradeFirstTask(e);
    if (execution.suite.id === "confirmation-replies" && scenario.id !== "task-card-accept") e.checks.push(...gradeConfirmationReply(e));
    input.observe(issue, runs, e);
    await input.evidence("first-task.json", e);
    await input.evidence("api-state.json", checkpoint);
    return checkpoint;
  };
  let pausedRuntimeRunIds = new Set<string>();
  const settle = async (priorRunIds: Set<string>, completion = false, rejection = false) => {
    const previousPaused = pausedRuntimeRunIds;
    let stable = 0;
    await pollUntil({
      label: "first-task response and durable outcome",
      deadlineAt: Math.min(deadlineAt, Date.now() + 300_000),
      intervalMs: 1000,
      load: async () => ({
        runs: await allRuns(),
        tasks: await api.get<Row[]>(tasksPath),
        interactions: await api.get<Row[]>(`/api/issues/${issue.id}/interactions`),
        comments: rejection ? await api.get<Row[]>(`/api/issues/${issue.id}/comments?order=asc`) : [],
      }),
      reject: ({ runs, tasks }) => {
        const bad = runs.find((r) =>
          ["failed", "timed_out", "cancelled"].includes(r.status) && !isBlockedUnstartedWake(r) &&
          !isTerminalUnstartedWake(r, tasks) && !(rejection && isFirstTaskRejectionCancellation(r, e, tasks)),
        );
        if (bad)
          return `run status ${bad.status}: ${bad.errorCode ?? ""} ${bad.error ?? ""}`;
        if (runs.length > 12) return "first-task run count exceeded 12";
      },
      accept: ({ runs, tasks, interactions, comments }) => {
        const paused = answerableRuntimeRunIds(interactions);
        const active = activeRuns(runs);
        const waitingForAnswer = !completion && active.length > 0 && active.every((r) => paused.has(r.id));
        const progressed = runs.some((r) => !priorRunIds.has(r.id) || previousPaused.has(r.id));
        const settled = progressed && (active.length === 0 || waitingForAnswer);
        pausedRuntimeRunIds = waitingForAnswer ? paused : new Set();
        const done =
          !completion ||
          firstTaskCompletionSettled(
            tasks,
            e.initialTaskIds,
            e.onboardingIssueId,
          );
        const replied = !rejection || firstTaskRejectionReplyRecorded(e, comments, runs);
        stable = settled && done && replied ? stable + 1 : 0;
        return stable >= 3;
      },
    });
  };
  const turn = async (
    message: string,
    phase: FirstTaskCheckpoint["phase"],
    complete = false,
  ) => {
    const before = new Set((await allRuns()).map((r) => r.id));
    const loadComments = () =>
      api.get<Row[]>(`/api/issues/${issue.id}/comments?order=asc`);
    const previousIds = new Set(
      (await loadComments()).map((comment) => comment.id),
    );
    const at = new Date().toISOString();
    await sendChatMessage(page, message);
    await waitForFirstTaskReply({
      load: loadComments,
      previousIds,
      message,
      deadlineAt: Math.min(deadlineAt, Date.now() + 30_000),
    });
    const decision = phase === "accepted" || phase === "rejected";
    if (decision) await snapshot(phase, at);
    await settle(before, complete, phase === "rejected");
    return snapshot(decision ? "finished" : phase);
  };
  let failure: unknown;
  try {
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: new URL("../../", import.meta.url),
        encoding: "utf8",
      }).trim();
    e.source = {
      sha: git(["rev-parse", "HEAD"]),
      ref: git(["branch", "--show-current"]),
      dirty: Boolean(git(["status", "--porcelain"])),
    };
    const agent = await api.get<Row>(`/api/agents/${fixtures.agent.id}`);
    e.configuredModel = agent.adapterConfig?.model ?? null;
    e.runtimeSettings = {
      completionDeliveryProbe: runsCompletionUpdateProbe(execution),
      onboardingRuntime: fixtures.onboardingRuntime,
      adapterType: agent.adapterType,
      adapterConfig: agent.adapterConfig,
      runtimeConfig: agent.runtimeConfig,
      permissions: agent.permissions,
    };
    const desired =
      agent.adapterConfig?.paperclipSkillSync?.desiredSkills ?? [];
    expect(
      desired.map((s: string | { key: string }) =>
        typeof s === "string" ? s : s.key,
      ),
    ).toContain("paperclipai/paperclip/first-task");
    const bundle = await api.get<{ files: Array<{ path: string }> }>(
      `/api/agents/${fixtures.agent.id}/instructions-bundle`,
    );
    for (const file of bundle.files) {
      const detail = await api.get<{ content: string }>(
        `/api/agents/${fixtures.agent.id}/instructions-bundle/file?path=${encodeURIComponent(file.path)}`,
      );
      e.instructions.push(
        snapshotInstruction(file.path, detail.content, input.secrets),
      );
    }
    const skills = await api.get<Row[]>(
      `/api/companies/${fixtures.company.id}/skills`,
    );
    for (const selection of desired) {
      const key = typeof selection === "string" ? selection : selection.key;
      const skill = skills.find((s) => s.key === key);
      if (!skill) throw new Error(`Missing assigned skill ${key}`);
      const file = await api.get<{ content: string }>(
        `/api/companies/${fixtures.company.id}/skills/${skill.id}/files?path=SKILL.md`,
      );
      e.instructions.push(
        snapshotInstruction(
          `${skill.slug}/SKILL.md`,
          file.content,
          input.secrets,
        ),
      );
    }
    // The execution contract is appended by production runners outside the managed persona.
    const contract = await readFile(
      new URL(
        "../../server/src/onboarding-assets/default/AGENTS.md",
        import.meta.url,
      ),
      "utf8",
    );
    e.instructions.push(
      snapshotInstruction("runtime/default/AGENTS.md", contract, input.secrets),
    );
    await snapshot("opening");
    await page.goto(
      `/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`,
    );
    if (scenario.opening === "ordinary") {
      const before = new Set((await allRuns()).map((r) => r.id));
      issue = await input.createOrdinary(
        execution.task.buildTitle(nonce),
        scenario.prompt,
      );
      e.initialTaskIds.push(issue.id);
      input.observe(issue, [], e);
      expect(issue.description).not.toContain("/first-task");
      await page.goto(
        `/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`,
      );
      await settle(before);
      await snapshot("response");
    } else if (scenario.opening === "message") {
      await turn(scenario.prompt, "response");
    } else {
      const opening = e.checkpoints[0].interactions.find(
        (i) => i.kind === "ask_user_questions" && i.status === "pending",
      );
      expect(opening, "deterministic opening card").toBeTruthy();
      const option = opening!.payload.questions[0].options.find(
        (o: any) =>
          o.id === (scenario.opening === "interview" ? "interview" : "task"),
      );
      await page
        // Paperclip includes the option description in the accessible name.
        .getByRole("radio", { name: option.label })
        .last()
        .click();
      if (scenario.opening !== "interview")
        await page
          .getByTestId("question-other-answer-composer")
          .last()
          .locator('[contenteditable="true"],textarea')
          .first()
          .fill(scenario.prompt);
      const before = new Set((await allRuns()).map((r) => r.id));
      await page
        .getByRole("button", {
          name: opening!.payload.submitLabel ?? "Continue",
          exact: true,
        })
        .last()
        .click();
      if (scenario.id === "accept-while-running") {
        await pollUntil({
          label: "approval card published before the source run finishes",
          deadlineAt: Math.min(deadlineAt, Date.now() + 300_000), intervalMs: 100,
          load: async () => ({ interactions: await api.get<Row[]>(`/api/issues/${issue.id}/interactions`), runs: await allRuns() }),
          accept: ({ interactions, runs }) => interactions.some(i => i.status === "pending" &&
            ["request_confirmation", "request_checkbox_confirmation"].includes(i.kind) &&
            runs.some(r => r.id === i.sourceRunId && r.status === "running")),
          reject: ({ runs }) => runs.some(r => !before.has(r.id)) && !activeRuns(runs).length
            ? "Acceptance overlap was not exercised: source run finished before a live approval card was observed" : undefined,
        });
      } else await settle(before);
      await snapshot("response");
    }
    // Screenshots can take longer than the source turn's final handoff. In the
    // overlap case, accept first and retain the response checkpoint as evidence.
    if (scenario.id !== "accept-while-running") await input.capture(
      "first-task-response",
      "First onboarding response",
      "first-task-response.png",
    );
    const assertBeforeAcceptance = () => {
      const check = gradeFirstTask(e).find((c) => c.id === "no-premature-work");
      expect(
        check?.passed ?? true,
        "Behavior failure: work executed before acceptance",
      ).toBe(true);
    };
    assertBeforeAcceptance();
    if (!scenario.firstResponseOnly) {
      if (["interview", "ambiguous"].includes(scenario.opening)) {
        const facts =
          scenario.id === "interview-plan-accept"
            ? `${scenario.facts} Please write a plan for me to review, before doing the work.`
            : scenario.facts;
        const pending = (
          await api.get<Row[]>(`/api/issues/${issue.id}/interactions`)
        ).find(
          (i) => i.status === "pending" && i.kind === "ask_user_questions",
        );
        if (!pending) await turn(facts, "clarified");
        else {
          const set = chatQuestionPresentation(pending.payload);
          const before = new Set((await allRuns()).map((r) => r.id));
          for (const [index, question] of set.questions.entries()) {
            const text = page
              .getByTestId("question-text-answer-composer")
              .last();
            if (await text.isVisible())
              await text
                .locator('[contenteditable="true"],textarea')
                .first()
                .fill(facts);
            else {
              await page
                .getByRole(
                  question.answerMode === "multi_select" ? "checkbox" : "radio",
                  {
                    name: question.customAnswer?.label ?? "Other",
                    exact: true,
                  },
                )
                .last()
                .click();
              await page
                .getByTestId("question-other-answer-composer")
                .last()
                .locator('[contenteditable="true"],textarea')
                .first()
                .fill(facts);
            }
            await page
              .getByRole("button", {
                name:
                  index === set.questions.length - 1
                    ? (set.submitLabel ?? "Submit answers")
                    : "Next",
                exact: true,
              })
              .last()
              .click();
          }
          await settle(before);
          await snapshot("clarified");
        }
      }
      if (scenario.id === "revise-accept")
        await turn(scenario.revision, "revised");
      assertBeforeAcceptance();
      if (scenario.id === "reject-no-execution")
        await turn(scenario.rejection, "rejected");
      else if (["task-card-accept", "accept-while-running"].includes(scenario.id)) {
        const pending = (
          await api.get<Row[]>(`/api/issues/${issue.id}/interactions`)
        ).find(
          (i) =>
            i.status === "pending" &&
            ["request_confirmation", "request_checkbox_confirmation"].includes(
              i.kind,
            ),
        );
        expect(
          pending,
          "proposal must offer an acceptance card in this case",
        ).toBeTruthy();
        const before = new Set((await allRuns()).map((r) => r.id));
        const at = new Date().toISOString();
        if (pending!.kind === "request_checkbox_confirmation") {
          for (const item of pending!.payload.options ?? [])
            await page
              .getByRole("checkbox", { name: item.label, exact: true })
              .last()
              .check();
        }
        await page
          .getByRole("button", {
            name:
              pending!.payload.acceptLabel ??
              (pending!.kind === "request_confirmation"
                ? "Approve"
                : "Confirm selection"),
            exact: true,
          })
          .last()
          .click();
        await pollUntil({
          label: "first-task confirmation acceptance",
          deadlineAt: Math.min(deadlineAt, Date.now() + 30_000),
          intervalMs: 250,
          load: () => api.get<Row[]>(`/api/issues/${issue.id}/interactions`),
          accept: (interactions) =>
            interactions.find((i) => i.id === pending!.id)?.status ===
            "accepted",
          reject: (interactions) => {
            const status = interactions.find(
              (i) => i.id === pending!.id,
            )?.status;
            return status && !["pending", "accepted"].includes(status)
              ? `Confirmation ended as ${status}`
              : undefined;
          },
        });
        await snapshot("accepted", at);
        await settle(before, true);
        await snapshot("finished");
      } else
        await turn(
          scenario.acceptance,
          "accepted",
          scenario.id !== "interview-plan-accept",
        );
    }
    if (execution.suite.id === "confirmation-replies" && scenario.id !== "task-card-accept") {
      const last = e.checkpoints.at(-1)!;
      const decisionCard = last.interactions.find(card => card.result?.commentId && ["accepted", "rejected"].includes(card.status));
      if (decisionCard) {
        await page.reload({ waitUntil: "domcontentloaded" });
        await assertConfirmationReceipt(page, decisionCard);
      }
      await input.evidence("confirmation-audit.json", await api.get(`/api/issues/${issue.id}/activity`));
    }
    if (runsCompletionUpdateProbe(execution)) {
      const children = (await api.get<Row[]>(tasksPath)).filter(t => t.parentId === issue.id);
      expect(children).toHaveLength(1);
      const completion = await observeCompletionUpdate({ ...input, sourceId: issue.id, workerId: children[0]!.id,
        marker: scenario.marker, fixtureRequest: firstTaskUserRequest(e), allRuns });
      e.runtimeSettings!.completionRenderedLinks = completion.renderedLinks ?? [];
      await snapshot("finished");
    }
    e.checks = gradeFirstTask(e);
    if (execution.suite.id === "confirmation-replies" && scenario.id !== "task-card-accept") e.checks.push(...gradeConfirmationReply(e));
    await input.evidence("first-task.json", e);
    await input.capture(
      "final-state",
      "First-task final state",
      "final-state.png",
    );
    const failures = e.checks.filter((c) => !c.passed);
    expect(
      failures,
      failures.map((c) => `${c.id}: ${c.detail}`).join("\n"),
    ).toEqual([]);
    return { issue, runs: e.checkpoints.at(-1)!.runs, evidence: e };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // Save failed journeys without replacing the original assertion/transport error.
    try {
      await snapshot("finished");
      const runs = await allRuns();
      await input.evidence(
        "first-task-run-evidence.json",
        await Promise.all(
          runs.map((r) =>
            collectChatRunEvidence(
              api,
              r as Parameters<typeof collectChatRunEvidence>[1],
            ),
          ),
        ),
      );
    } catch (error) {
      if (!failure) throw error;
      await input.evidence("first-task-evidence-error.json", {
        captureFailed: true,
      });
    }
  }
}
