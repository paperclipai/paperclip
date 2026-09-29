import { isBlockedUnstartedWake } from "./non-execution-wake.js";
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
import type { CredentialName, MatrixExecution } from "./types.js";
import { firstTaskScenario } from "./first-task-cases.js";
import {
  activeRuns,
  snapshotInstruction,
  gradeFirstTask,
  firstTaskCompletionSettled,
  type FirstTaskEvidence,
  type FirstTaskCheckpoint,
  type Row,
} from "./first-task-scoring.js";

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
      ? "codex_local"
      : "claude_local";
  expect(agents[0].adapterType).toBe(wizardAdapter);
  fixtures.onboardingRuntime = {
    mode: "production-wizard",
    originalAdapterType: wizardAdapter,
    testedAdapterType: wizardAdapter,
    originalModel: agents[0].adapterConfig?.model ?? null,
  };
  if (execution.profile.generation === "native") {
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
    input.observe(issue, runs, e);
    await input.evidence("first-task.json", e);
    await input.evidence("api-state.json", checkpoint);
    return checkpoint;
  };
  let pausedRuntimeRunIds = new Set<string>();
  const settle = async (priorRunIds: Set<string>, completion = false) => {
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
      }),
      reject: ({ runs }) => {
        const bad = runs.find((r) =>
          ["failed", "timed_out", "cancelled"].includes(r.status) && !isBlockedUnstartedWake(r),
        );
        if (bad)
          return `run status ${bad.status}: ${bad.errorCode ?? ""} ${bad.error ?? ""}`;
        if (runs.length > 12) return "first-task run count exceeded 12";
      },
      accept: ({ runs, tasks, interactions }) => {
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
        stable = settled && done ? stable + 1 : 0;
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
    if (phase === "accepted") await snapshot("accepted", at);
    await settle(before, complete);
    return snapshot(phase === "accepted" ? "finished" : phase);
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
      completionDeliveryProbe: execution.suite.id === "completion-updates",
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
    if (execution.suite.id === "completion-updates") {
      const children = (await api.get<Row[]>(tasksPath)).filter(t => t.parentId === issue.id);
      expect(children).toHaveLength(1);
      const completion = await observeCompletionUpdate({ ...input, sourceId: issue.id, workerId: children[0]!.id,
        marker: scenario.marker, allRuns });
      e.runtimeSettings!.completionRenderedLinks = completion.renderedLinks ?? [];
      await snapshot("finished");
    }
    e.checks = gradeFirstTask(e);
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
