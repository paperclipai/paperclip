import { expect, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pollUntil, type RunnerApi } from "./api.js";
import {
  latestStoryDelivery,
  type StoryDelivery,
} from "./everyday-delivery.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";
import { createTaskThroughUi, submitTaskReply } from "./user-actions.js";
import { waitForTaskChatRendered } from "./continuation-screenshot.js";
import { hasPersistedSource, isSavedSourceCheckpoint } from "./everyday-interruption.js";
import { setupAggregatorFixture } from "./aggregator-fixture.js";
import { gradeProviderChoice, gradeProviderOutcome } from "./connection-routing-evidence.js";
import { setupConnectionReview } from "./connection-reviews.js";
import {
  pendingStoryDecision,
  StoryDecisionError,
  type StoryInteraction,
} from "./everyday-decisions.js";
import { LATE_REQUIREMENT, SLUGIFY_REVISION, requiresEverydayArtifactOracle } from "./everyday-cases.js";
import {
  isActiveStoryRun,
  isStoryWorkspaceDeferral,
  isExpectedStoryInterruption,
  storyUnexpectedRunFailure,
  storyUnexercisedReviewBoundary,
  storyLifecycleChecks,
  storyRepliesConsumed,
  storyHasAgentReply,
  storyHasPendingHumanInteraction,
  storyReviewContinuationTimeoutDetail,
  storyHasStrandedBlockedLeaf,
  storyHasDurableAgentReviewContinuation,
  storyIssueHasBlockedTimelineBefore,
  storyIssueHasUnresolvedDependency,
  storyRunReportsDependencyBlock,
  storyParentFinishedAfterChildren,
  storyAcceptedAgentReview,
  artifactGradeModeForPhase,
  storyParentCompletionPrecedesReview,
  type StoryCheck,
  type StoryIssue,
  type StoryRun,
} from "./everyday-observations.js";

type Row = Record<string, any>;
export interface EverydayEvidence {
  schema: "paperclip.everyday-workflow.v1";
  caseId: string;
  prompt: string;
  harnessDigest?: string;
  sourceRevision?: string;
  providerVersion?: string;
  fixtureConfiguration?: {
    apiToolsEnabled: boolean;
    aiConnection?: LiveFixtureValues["aiConnection"];
  };
  documents?: Row[];
  checks: StoryCheck[];
  timeline: Array<{ at: string; action: string; detail?: unknown }>;
  issues: Array<StoryIssue & Row>;
  runs: StoryRun[];
  agents: Row[];
  downloads: Row[];
  allowedInterruptedRuns: string[];
}
interface Input {
  page: Page;
  api: RunnerApi;
  fixtures: LiveFixtureValues;
  execution: MatrixExecution;
  nonce: string;
  workspacePath: string;
  privateDir: string;
  deadlineAt: number;
  restart(): Promise<void>;
  observe(issue: StoryIssue, runs: StoryRun[]): void;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, value: unknown): Promise<void>;
}

function runCommand(
  command: string,
  args: string[],
  timeout = 20_000,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        ["PATH", "SYSTEMROOT", "TMPDIR"].includes(key),
      ),
    );
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 1_000_000) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === null)
        reject(new Error("Bounded evaluator command timed out"));
      else resolve({ code, stdout: stdout || stderr });
    });
  });
}

/** No DB writes, fabricated tool receipts, or corrective messages after a failed check. */
export async function runEverydayFlow(input: Input) {
  const { page, api, fixtures, execution, nonce } = input;
  const prefix = fixtures.company.issuePrefix!;
  const ev: EverydayEvidence = {
    schema: "paperclip.everyday-workflow.v1",
    caseId: execution.task.id,
    prompt: execution.task.buildPrompt(nonce),
    fixtureConfiguration: {
      apiToolsEnabled:
        process.env.PAPERCLIP_RUNNER_API_TOOLS_ENABLED === "true",
      aiConnection: fixtures.aiConnection,
    },
    checks: [],
    timeline: [],
    issues: [],
    runs: [],
    agents: [],
    downloads: [],
    allowedInterruptedRuns: [],
  };
  const note = (action: string, detail?: unknown) =>
    ev.timeline.push({
      at: new Date().toISOString(),
      action,
      ...(detail === undefined ? {} : { detail }),
    });
  const check = (id: string, passed: boolean, detail: string) => {
    ev.checks.push({ id, passed, detail });
  };
  let parent: StoryIssue | undefined;
  let lastSubmissionAt = 0;
  const submittedCommentIds: string[] = [];
  let review: Awaited<ReturnType<typeof setupConnectionReview>> | undefined;
  let project = fixtures.project;
  const caseId = execution.task.id;
  const providerChoice = caseId === "provider-decline" || caseId === "provider-second";
  const nativeProviderCase = caseId === "provider-native";
  let aggregatorFixture: Awaited<ReturnType<typeof setupAggregatorFixture>> | undefined;
  const decliningConnection = caseId === "connection-decline" || nativeProviderCase;
  const declining = decliningConnection || caseId === "service-decline";
  let decisionId: string | undefined;
  let decisionResolvedAt: string | undefined;
  let initialConnections: string[] = [];
  let stoppedWorkspace: Record<string, string> | undefined;
  let settledAgentReply: Row | undefined;
  let reviewHandoffBoundary: {
    childId: string;
    assigneeAgentId: string | null | undefined;
    interactionId: string;
    interactionCreatedAt?: string;
    parentRunId?: string;
    parentBlockedObserved: boolean;
  } | undefined;
  async function workspaceFiles() {
    const workspaceRoot = input.workspacePath;
    const files: Record<string, string> = {};
    for (const entry of await readdir(workspaceRoot, {
      withFileTypes: true,
    })) {
      if (entry.isFile() && /\.(py|md|zip)$/.test(entry.name))
        files[entry.name] = createHash("sha256")
          .update(await readFile(path.join(workspaceRoot, entry.name)))
          .digest("hex");
    }
    return files;
  }
  async function runnerStopped(run: StoryRun) {
    if (!run.processPid) return false;
    const identity = await runCommand("ps", [
      "-p",
      String(run.processPid),
      "-o",
      "command=",
    ]);
    return (
      identity.code !== 0 || !identity.stdout.includes(`--run-id ${run.id} `)
    );
  }
  async function refresh() {
    const listed = await api.get<StoryRun[]>(
      `/api/companies/${fixtures.company.id}/heartbeat-runs?limit=100`,
    );
    ev.runs = await Promise.all(
      listed.map((r) => api.get<StoryRun>(`/api/heartbeat-runs/${r.id}`)),
    );
    const issues = await api.get<StoryIssue[]>(
      `/api/companies/${fixtures.company.id}/issues`,
    );
    ev.issues = await Promise.all(
      issues.map(async (issue) => ({
        ...issue,
        comments: await api.get<Row[]>(
          `/api/issues/${issue.id}/comments?order=asc`,
        ),
        queuedComments: await api.get<Row>(
          `/api/issues/${issue.id}/queued-comments`,
        ),
        interactions: await api.get<Row[]>(
          `/api/issues/${issue.id}/interactions`,
        ),
        wakeDiagnostics: await api.get<Row>(
          `/api/issues/${issue.id}/diagnostics/wakes`,
        ),
        activity: await api.get<Row[]>(`/api/issues/${issue.id}/activity`),
      })),
    );
    if (parent) {
      parent = ev.issues.find((i) => i.id === parent!.id) as StoryIssue;
      input.observe(parent!, ev.runs);
    }
    return ev;
  }
  const taskUrl = (issue: StoryIssue) =>
    `/${prefix}/issues/${issue.identifier ?? issue.id}`;
  async function openTask(issue: StoryIssue) {
    await page.goto(taskUrl(issue), { waitUntil: "domcontentloaded" });
    if (providerChoice || nativeProviderCase) {
      await expect(page.locator('[data-testid="task-chat-thread"], [data-testid="thread-root"]').first()).toBeVisible({timeout:30_000});
      await expect(page.getByRole("heading", {name:String(issue.title),exact:true})).toBeVisible();
      await expect(page.getByTestId("issue-chat-skeleton")).toHaveCount(0);
    } else await waitForTaskChatRendered(page, String(issue.title));
  }
  async function openParent() {
    await openTask(parent!);
  }
  function observableAgentIds(state: EverydayEvidence) {
    return [
      fixtures.agent.id,
      ...state.issues.flatMap((issue) =>
        [
          issue.assigneeAgentId,
          ...(issue.interactions ?? []).map(
            (interaction) => interaction.addresseeAgentId,
          ),
        ].filter((agentId): agentId is string => Boolean(agentId)),
      ),
    ];
  }
  async function reply(message: string, target: StoryIssue = parent!) {
    const priorFailures = ev.checks.filter((c) => !c.passed);
    if (priorFailures.length)
      throw new Error(
        `Story prerequisite failed before the next user request: ${priorFailures.map((c) => c.id).join(", ")}`,
      );
    const before = await api.get<Row[]>(`/api/issues/${target.id}/comments`);
    lastSubmissionAt = Date.now();
    await submitTaskReply(page, message);
    const after = await pollUntil({
      label: "one persisted user reply",
      deadlineAt: Date.now() + 30_000,
      load: () => api.get<Row[]>(`/api/issues/${target.id}/comments`),
      accept: (rows) =>
        rows.filter(
          (c) => !c.authorAgentId && !before.some((old) => old.id === c.id),
        ).length > 0,
    });
    const added = after.filter(
      (c) => !c.authorAgentId && !before.some((old) => old.id === c.id),
    );
    check(
      `reply-${ev.timeline.length}-stored-once`,
      added.length === 1,
      "A composer submission creates exactly one user message.",
    );
    submittedCommentIds.push(...added.map((c) => c.id));
    note("composer-message-persisted", {
      issueId: target.id,
      commentIds: added.map((c) => c.id),
    });
  }
  async function settled(expectedAgentReply?: string) {
    const settledState = await pollUntil({
      label: `everyday ${caseId} settled`,
      deadlineAt: input.deadlineAt,
      timeoutDetail: (state) => state &&
        storyReviewContinuationTimeoutDetail(
          state.issues, parent?.id ?? "", fixtures.agent.id, state.runs,
          observableAgentIds(state),
        ),
      intervalMs: 1000,
      load: refresh,
      accept: (state) =>
        state.issues.length > 0 &&
        state.issues.every(
          (i) => i.status === "done" && i.queuedComments.entries.length === 0,
        ) &&
        storyRepliesConsumed(state.runs, submittedCommentIds) &&
        state.runs.length > 0 &&
        !state.runs.some(isActiveStoryRun) &&
        state.runs.some(
          (r) => Date.parse(r.finishedAt ?? "") >= lastSubmissionAt,
        ) &&
        (!expectedAgentReply ||
          storyHasAgentReply(
            state.issues.find((issue) => issue.id === parent?.id),
            fixtures.agent.id,
            expectedAgentReply,
          )),
      reject: (state) => {
        if (state.runs.length > 12) return "bounded execution count exceeded";
        const bad = storyUnexpectedRunFailure(state.runs, ev.allowedInterruptedRuns);
        if (bad)
          return `native execution failed ${bad.errorCode ?? ""}: ${bad.error ?? bad.status}`;
        if (
          state.runs.some(isActiveStoryRun) ||
          state.issues.some((i) => i.scheduledRetry || i.activeRecoveryAction)
        )
          return;
        if (
          state.runs.length &&
          storyHasStrandedBlockedLeaf(state.issues, observableAgentIds(state)) &&
          !storyHasDurableAgentReviewContinuation(
            state.issues,
            parent?.id ?? "",
            fixtures.agent.id,
            state.runs,
          )
        )
          return "task is Blocked without an active continuation";
        if (
          state.issues.some(
            (i) =>
              i.status === "in_review" &&
              storyHasPendingHumanInteraction(i, observableAgentIds(state)),
          )
        )
          return "unexpected human interaction: task did not finish autonomously";
      },
    });
    if (expectedAgentReply) {
      const issue = settledState.issues.find((candidate) => candidate.id === parent?.id);
      const reply = issue?.comments?.find(
        (comment) =>
          comment.authorAgentId === fixtures.agent.id &&
          String(comment.body ?? "").includes(expectedAgentReply),
      );
      if (reply) {
        // Keep the exact snapshot that satisfied the readiness predicate. A
        // later refresh may return a newer projection and must not change the
        // evidence used by the assertion below.
        settledAgentReply = { ...reply };
        note("expected-agent-reply-visible-at-settlement", {
          issueId: issue?.id,
          commentId: reply.id,
          authorAgentId: reply.authorAgentId,
          createdAt: reply.createdAt,
          body: reply.body,
        });
      }
    }
    await openParent();
    await expect(
      page.getByTestId("issue-detail-header").getByRole("button", {
        name: "Change status (current: Done)",
        exact: true,
      }),
    ).toBeVisible();
    note("all-tasks-done");
  }
  async function downloadDelegated(
    mode: "base" | "separator" | "max-length",
    phase: string,
    after?: number,
  ) {
    const related = ev.issues.filter(
      (issue) => issue.id === parent!.id || issue.parentId === parent!.id,
    );
    const attachments = (
      await Promise.all(
        related.map(async (issue) =>
          (await api.get<Row[]>(`/api/issues/${issue.id}/attachments`)).map(
            (a) => ({ ...a, issueId: issue.id }) as StoryDelivery,
          ),
        ),
      )
    ).flat();
    const delivery = latestStoryDelivery(
      attachments,
      related.map((issue) => issue.id),
      after,
      after === undefined ? [] : ev.downloads.map((d) => d.sha256),
    );
    if (!delivery) {
      check(
        `${phase}.zip-delivered`,
        false,
        "No new downloadable ZIP was delivered on the parent or its child tasks.",
      );
      return;
    }
    note("delivery-selected", { attachmentId: delivery.id, issueId: delivery.issueId, sha256: delivery.sha256, after });
    await download(delivery.issueId, mode, phase, delivery.id);
  }

  async function download(
    issueId: string,
    mode: "base" | "separator" | "max-length",
    phase: string,
    selectedAttachmentId?: string,
  ) {
    const attachments = await api.get<Row[]>(
      `/api/issues/${issueId}/attachments`,
    );
    const zips = attachments
      .filter(
        (a) =>
          String(a.originalFilename ?? a.filename ?? "").endsWith(".zip") ||
          a.contentType === "application/zip",
      )
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (!zips.length) {
      check(
        `${phase}.zip-delivered`,
        false,
        "No downloadable ZIP attachment was delivered.",
      );
      return;
    }
    const attachment = selectedAttachmentId
      ? zips.find((a) => a.id === selectedAttachmentId)
      : zips[zips.length - 1];
    if (!attachment) throw new Error("Selected delivery is no longer available");
    const issue = ev.issues.find((i) => i.id === issueId)!;
    await openTask(issue);
    const links = page.locator(
      `a[href*="/api/attachments/${attachment.id}/content"]`,
    );
    const link = links.filter({ hasText: /Download/i }).first();
    await expect(link).toBeVisible({ timeout: 15_000 });
    const pending = page.waitForEvent("download", { timeout: 30_000 });
    await link.click();
    const file = await pending;
    const target = path.join(input.privateDir, "snapshots", `${phase}.zip`);
    await file.saveAs(target);
    const bytes = await readFile(target);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const result = await runCommand(process.env.PYTHON ?? "python3", [
      path.join(import.meta.dirname, "everyday-artifact.py"),
      target,
      "--mode",
      mode,
    ], Math.max(1, Math.min(60_000, input.deadlineAt - Date.now())));
    const oracle = JSON.parse(result.stdout) as { checks: StoryCheck[] };
    ev.checks.push(
      ...oracle.checks.map((c) => ({ ...c, id: `${phase}.${c.id}` })),
    );
    ev.downloads.push({
      phase,
      attachmentId: attachment.id,
      issueId,
      sha256: digest,
      bytes: bytes.length,
      filename: file.suggestedFilename(),
      mode,
    });
    note("download-verified", {
      phase,
      attachmentId: attachment.id,
      sha256: digest,
    });
    await openParent();
  }
  async function recordSource(
    label = "source-saved-before-interruption",
    evidenceName = "source-before-interruption.json",
    requireActive = false,
    maxWaitMs = 180_000,
  ) {
    const filePath = path.join(input.workspacePath, "slugify.py");
    const bytes = await pollUntil({
      label: requireActive ? "active run with saved source" : "saved source after interruption",
      deadlineAt: Math.min(input.deadlineAt, Date.now() + maxWaitMs),
      intervalMs: 500,
      load: async () => {
        await refresh();
        const source = await readFile(filePath).catch(() => undefined);
        return { active: ev.runs.some(isActiveStoryRun), source };
      },
      accept: ({ active, source }) =>
        requireActive
          ? isSavedSourceCheckpoint(active, source)
          : hasPersistedSource(source),
    });
    if (!bytes.source) throw new Error("Saved source was not available at the controlled boundary");
    await input.evidence(evidenceName, {
      body: bytes.source.toString("utf8"),
      sha256: createHash("sha256").update(bytes.source).digest("hex"),
    });
    note(label, {
      sha256: createHash("sha256").update(bytes.source).digest("hex"),
      bytes: bytes.source.length,
      active: bytes.active,
    });
  }
  async function sourceReady() {
    await recordSource("source-saved-before-interruption", "source-before-interruption.json", true);
  }
  async function prepareStopBoundary() {
    // Providers can finish a short first turn before the browser can click
    // Stop. If that happens, submit one ordinary user follow-up through the
    // composer and use that fresh run as the controlled interruption boundary.
    // Save the checkpoint even if a fast provider has already finished. Do
    // not shorten the normal source-creation budget to manufacture a timeout.
    await recordSource("source-saved-before-interruption", "source-before-interruption.json");
    await refresh();
    if (ev.runs.some(isActiveStoryRun)) return;
    await submitTaskReply(page, `${SLUGIFY_REVISION}\nContinue working until the source file is saved.`);
    note("stop-boundary-continuation-submitted");
    await recordSource(
      "source-saved-before-interruption",
      "source-before-interruption.json",
      true,
    );
  }
  try {
    await mkdir(path.join(input.privateDir, "snapshots"), { recursive: true });
    const revision = await runCommand("git", ["rev-parse", "HEAD"]);
    if (revision.code === 0) ev.sourceRevision = revision.stdout.trim();
    // Native providers run the packaged runtime (possibly remotely). A host
    // `claude`/`codex` binary is neither required nor its observed version.
    const harnessFiles = [
      "everyday-flow.ts",
      "everyday-cases.ts",
      "everyday-decisions.ts",
      "aggregator-fixture.ts",
      "connection-routing-evidence.ts",
      "everyday-delivery.ts",
      "everyday-observations.ts",
      "everyday-artifact.py",
      "user-actions.ts",
      "runner.spec.ts",
      "api.ts",
      "harness-env.ts",
      "failure-classifier.ts",
      "live-fixtures.ts",
      "connection-reviews.ts",
      "catalog.ts",
    ];
    ev.harnessDigest = createHash("sha256")
      .update(
        (
          await Promise.all(
            harnessFiles.map((f) =>
              readFile(path.join(import.meta.dirname, f)),
            ),
          )
        )
          .map((b) => b.toString())
          .join("\n"),
      )
      .digest("hex");
    if (requiresEverydayArtifactOracle(caseId)) {
      try {
        const sandbox = await runCommand(process.env.PYTHON ?? "python3", [
          path.join(import.meta.dirname, "everyday-artifact.py"), "--preflight",
        ]);
        if (sandbox.code !== 0) throw new Error(sandbox.stdout);
        note("artifact-sandbox-qualified", { isolation: "docker", network: "none" });
      } catch (error) {
        throw new Error(`Artifact sandbox qualification failed before task creation: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    if (!project && !caseId.startsWith("service-") && !decliningConnection && !providerChoice) {
      project = await api.post(
        `/api/companies/${fixtures.company.id}/projects`,
        {
          name: `Studio project ${nonce}`,
          description: "Small software project",
          executionWorkspacePolicy: {
            enabled: true,
            defaultMode: "shared_workspace",
            sharedWorkspaceConcurrency: "serialize",
            allowIssueOverride: false,
            environmentId: fixtures.environment.id,
            workspaceStrategy: { type: "project_primary" },
          },
          workspace: {
            name: "Primary",
            sourceType: "local_path",
            cwd: input.workspacePath,
            isPrimary: true,
          },
        },
      );
    }
    await api.patch(`/api/agents/${fixtures.agent.id}/permissions`, {
      canCreateAgents: true,
      canAssignTasks: true,
    });
    if (caseId === "delegate-feedback" || caseId === "agent-review-handoff") {
      const config = execution.profile.buildAgent({
        environmentId: fixtures.environment.id,
        environmentFixtureId: execution.environment.id,
        workspacePath: input.workspacePath,
        secretRefs: fixtures.secretRefs,
        executionId: nonce,
      });
      await api.post(`/api/companies/${fixtures.company.id}/agents`, {
        ...config,
        name: "Riley Builder",
        role: "engineer",
        title: "Engineer",
        reportsTo: fixtures.agent.id,
        instructionsBundle: {
          entryFile: "AGENTS.md",
          files: {
            "AGENTS.md":
              "You implement small software projects and verify your work. Follow task feedback and deliver usable files.",
          },
        },
      });
    }
    if (caseId.startsWith("service-"))
      review = await setupConnectionReview({
        page,
        api,
        prefix,
        companyId: fixtures.company.id,
        agentId: fixtures.agent.id,
        marker: `Pages: Roadmap, Meeting notes. Verification code: SERVICE_${nonce}`,
        authenticated: true,
      });
    if (providerChoice || nativeProviderCase) {
      if (caseId === "provider-second") aggregatorFixture = await setupAggregatorFixture(api, fixtures.company.id, fixtures.agent.id, `CONTACTS_${nonce}`);
      const state = await api.get<{connections:Row[]}>(`/api/companies/${fixtures.company.id}/tools/connections`);
      initialConnections = state.connections.map(c=>c.id);
    }
    if (decliningConnection) {
      const state = await api.get<{ connections: Row[] }>(
        `/api/companies/${fixtures.company.id}/tools/connections`,
      );
      initialConnections = state.connections.map((c) => c.id);
      check(
        "connection-starts-unconfigured",
        state.connections.length === 0,
        "This isolated company has no service connection before the request.",
      );
      if (state.connections.length)
        throw new Error("New-connection story requires an unconnected company");
    }
    await createTaskThroughUi({
      page,
      issuePrefix: prefix,
      agentName: fixtures.agent.name,
      title: execution.task.buildTitle(nonce),
      prompt: ev.prompt,
      workMode: "standard",
      projectName: project?.name,
    });
    parent = await pollUntil({
      label: "browser-created story task",
      deadlineAt: Date.now() + 30_000,
      load: () =>
        api.get<StoryIssue[]>(`/api/companies/${fixtures.company.id}/issues`),
      accept: (rows) =>
        rows.some((i) => i.title === execution.task.buildTitle(nonce)),
    }).then((rows) =>
      rows.find((i) => i.title === execution.task.buildTitle(nonce))!,
    );
    input.observe(parent!, []);
    note("task-submitted", { issueId: parent!.id });
    await openParent();
    if (caseId === "agent-review-handoff") {
      const boundary = await pollUntil({
        label: "blocked parent with agent review wake",
        deadlineAt: input.deadlineAt,
        load: refresh,
        accept: (state) => {
          const child = state.issues.find((issue) => issue.parentId === parent!.id);
          const interaction = child?.interactions?.find(
            (candidate) =>
              ["pending", "accepted"].includes(String(candidate.status)) &&
              candidate.addresseeAgentId === fixtures.agent.id &&
              candidate.effectiveResolverPolicy !== "human_only",
          );
          const parentIssue = state.issues.find((issue) => issue.id === parent!.id);
          const reviewRun = interaction?.resolvedByRunId
            ? state.runs.find((run) => run.id === interaction.resolvedByRunId)
            : undefined;
          const parentRun = state.runs.find(
            (run) =>
              (run.nativeIssueId === parent!.id ||
                run.contextSnapshot?.issueId === parent!.id ||
                run.contextSnapshot?.taskId === parent!.id) &&
              run.status === "succeeded" &&
              run.finishedAt &&
              (reviewRun?.startedAt
                ? Date.parse(run.finishedAt) <= Date.parse(reviewRun.startedAt)
                : parentIssue?.status === "blocked"),
          );
          const parentBlockedEvidence =
            Boolean(
              parentIssue && storyIssueHasUnresolvedDependency(parentIssue),
            ) ||
            Boolean(
              parentIssue &&
                storyIssueHasBlockedTimelineBefore(
                  parentIssue,
                  reviewRun?.startedAt ?? undefined,
                ),
            ) ||
            Boolean(parentRun && storyRunReportsDependencyBlock(parentRun));
          return Boolean(
              parentIssue &&
              ["blocked", "done"].includes(parentIssue.status) &&
              ["in_review", "done"].includes(String(child?.status)) &&
              interaction &&
              parentBlockedEvidence &&
              parentRun &&
              (parentIssue.status === "blocked" || reviewRun),
          );
        },
        reject: (state) => {
          const failed = state.runs.find((run) =>
            ["failed", "timed_out"].includes(run.status),
          );
          return failed
            ? `Review handoff prerequisite failed: ${failed.errorCode}: ${failed.error}`
            : storyUnexercisedReviewBoundary(state.issues, state.runs, parent!.id, fixtures.agent.id);
        },
      });
      const child = boundary.issues.find((issue) => issue.parentId === parent!.id)!;
      const interaction = child.interactions!.find(
        (candidate) =>
          ["pending", "accepted"].includes(String(candidate.status)) &&
          candidate.addresseeAgentId === fixtures.agent.id,
      )!;
      const reviewRun = interaction.resolvedByRunId
        ? boundary.runs.find((run) => run.id === interaction.resolvedByRunId)
        : undefined;
      const parentAtBoundary = boundary.issues.find(
        (issue) => issue.id === parent!.id,
      );
      const parentRun = boundary.runs.find(
        (run) =>
          (run.nativeIssueId === parent!.id ||
            run.contextSnapshot?.issueId === parent!.id ||
            run.contextSnapshot?.taskId === parent!.id) &&
          run.status === "succeeded" &&
          run.finishedAt &&
          storyParentCompletionPrecedesReview(
            run.finishedAt,
            reviewRun?.startedAt,
            parentAtBoundary?.status === "blocked",
          ),
      );
      reviewHandoffBoundary = {
        childId: child.id,
        assigneeAgentId: child.assigneeAgentId,
        interactionId: interaction.id!,
        interactionCreatedAt: interaction.createdAt,
        parentRunId: parentRun?.id,
        parentBlockedObserved: boundary.issues.some(
          (issue) =>
            issue.id === parent!.id && storyIssueHasUnresolvedDependency(issue),
        ),
      };
      check(
        "parent-blocked-before-agent-review",
        reviewHandoffBoundary.parentBlockedObserved || Boolean(parentRun),
        "The completed lead run and durable dependency projection precede the child review card.",
      );
      note("agent-review-requested", {
        childId: child.id,
        childAssigneeAgentId: child.assigneeAgentId,
        interactionId: interaction.id,
        parentStatus: boundary.issues.find((issue) => issue.id === parent!.id)?.status,
        parentRunId: parentRun?.id,
        parentRunFinishedAt: parentRun?.finishedAt,
        interactionCreatedAt: interaction.createdAt,
      });
      await openParent();
    }
    if (caseId === "delegate-feedback") {
      await pollUntil({
        label: "active delegated child",
        deadlineAt: input.deadlineAt,
        load: refresh,
        accept: (state) =>
          state.issues.some(
            (i) =>
              i.parentId === parent!.id &&
              state.runs.some(
                (r) =>
                  isActiveStoryRun(r) &&
                  (r.contextSnapshot?.issueId === i.id ||
                    r.contextSnapshot?.taskId === i.id),
              ),
          ),
        reject: (state) => {
          const failed = state.runs.find((run) =>
            ["failed", "timed_out"].includes(run.status),
          );
          return failed
            ? `Delegation prerequisite failed before feedback: ${failed.errorCode}: ${failed.error}`
            : undefined;
        },
      });
      const child = ev.issues.find((i) => i.parentId === parent!.id)!;
      note("late-feedback-boundary", {
        childId: child.id,
        activeRunIds: ev.runs.filter(isActiveStoryRun).map((r) => r.id),
      });
      await openTask(child);
      await reply(LATE_REQUIREMENT, child);
      note("late-feedback-delivered-to-child", { childId: child.id });
      await openParent();
    }
    if (
      caseId === "recover-controller" ||
      caseId === "stop-redirect"
    ) {
      if (execution.environment.id === "daytona") {
        // A completed, downloaded first version is an observable remote persistence checkpoint.
        await settled();
        await download(parent!.id, "base", "before-restart");
        if (!ev.downloads.length || ev.checks.some((c) => !c.passed))
          throw new Error(
            "Remote fault boundary unexercised: no verified saved project",
          );
        await reply(SLUGIFY_REVISION);
        note("remote-revision-submitted");
        await pollUntil({
          label: "remote revision executing",
          deadlineAt: input.deadlineAt,
          load: refresh,
          accept: (s) => s.runs.some(isActiveStoryRun),
        });
      } else if (caseId === "stop-redirect") await prepareStopBoundary();
      else await sourceReady();
      const active = ev.runs.find((r) => r.status === "running");
      if (!active)
        throw new Error(
          "Fault boundary was not exercised: no active execution",
        );
      if (caseId === "stop-redirect") {
        await page.getByTestId("task-chat-composer-stop").last().click();
        ev.allowedInterruptedRuns.push(active.id);
        note("stop-clicked", { runId: active.id });
        await pollUntil({
          label: "owned runner stopped",
          deadlineAt: input.deadlineAt,
          load: () => runnerStopped(active),
          accept: Boolean,
          intervalMs: 250,
        });
        await recordSource("source-saved-after-interruption", "source-after-interruption.json");
        stoppedWorkspace = await workspaceFiles();
        note("stopped-workspace-snapshot", stoppedWorkspace);
        await reply(
          `Change direction. Leave the project as it is. Reply with just this short note: "The studio is ready. Reference ${nonce}."`,
        );
        note("new-direction-submitted");
        await page.reload();
      } else {
        await reply(LATE_REQUIREMENT);
        note("followup-submitted-before-interruption");
        ev.allowedInterruptedRuns.push(active.id);
        await input.restart();
        note("controller-restarted");
        await openParent();
      }
    }
    if (providerChoice) {
      const rows = await pollUntil({
        label: "external-provider choice", deadlineAt: input.deadlineAt,
        load: async () => {
          const runs = await api.get<StoryRun[]>(`/api/issues/${parent!.id}/runs`);
          const failure = runs.find(run => ["failed", "timed_out"].includes(run.status));
          if (failure) throw new Error(`Stopped waiting for external-provider choice: agent failed before selection: ${failure.error ?? failure.status}`);
          const rows = await api.get<Row[]>(`/api/issues/${parent!.id}/interactions`);
          const issue = await api.get<StoryIssue>(`/api/issues/${parent!.id}`);
          if (!rows.some(row=>row.status==="pending") && ["done", "blocked", "cancelled"].includes(issue.status)) throw new Error(`Stopped waiting for external-provider choice: task reached ${issue.status} without asking the user`);
          return rows;
        },
        accept: rows => rows.some(row=>row.status==="pending"),
      });
      const decision = gradeProviderChoice(rows as any, aggregatorFixture?.invocationCount() ?? 0);
      decisionId = decision.interaction.id;
      check("provider-disclosed-before-choice", true, "Ranked external providers and None were offered before any call.");
      // Exercise durable selection across a real controller restart and browser reload.
      await input.restart();
      await openParent();
      const choice = page.getByRole("radio", {name: caseId === "provider-decline" ? /None for now/ : /^Arcade/});
      await expect(choice).toBeVisible();
      await input.capture("provider-choice", "External service choice after restart", "provider-choice.png");
      await choice.click();
      await page.getByRole("button", {name:"Submit answers",exact:true}).click();
      await pollUntil({label:"provider choice saved", deadlineAt:input.deadlineAt,
        load:()=>api.get<Row[]>(`/api/issues/${parent!.id}/interactions`),
        accept:rows=>rows.some(row=>row.id===decisionId && row.status==="answered"),
      });
      note("provider-choice-submitted", {interactionId:decisionId, selected:caseId === "provider-decline" ? "none" : "via:arcade:hubspot"});
    }
    if (review || decliningConnection) {
      const interactions = await pollUntil({
        label: "story decision request",
        deadlineAt: input.deadlineAt,
        load: async () => {
          const [interactions, issue] = await Promise.all([
            api.get<StoryInteraction[]>(
              `/api/issues/${parent!.id}/interactions`,
            ),
            api.get<StoryIssue>(`/api/issues/${parent!.id}`),
          ]);
          return { interactions, issue, calls: review?.invocationCount() ?? 0 };
        },
        accept: (state) =>
          state.interactions.some((i) => i.status === "pending"),
        reject: (state) =>
          state.calls > 0
            ? `The provider received ${state.calls} call(s) before approval.`
            : ["done", "blocked", "cancelled"].includes(state.issue.status)
              ? `Task reached ${state.issue.status} without requesting the expected decision.`
              : undefined,
      });
      await openParent();
      await expect(
        page
          .locator(
            '[data-testid="task-chat-thread"], [data-testid="thread-root"]',
          )
          .first(),
      ).toBeVisible();
      await expect(page.getByTestId("issue-chat-skeleton")).toHaveCount(0);
      const pendingInteraction = pendingStoryDecision(
        interactions.interactions,
        review
          ? { kind: "tool", connectionId: review.connectionId }
          : { kind: "connection", serviceSlug: nativeProviderCase ? "jira" : "notion" },
      );
      await expect(
        page.getByRole("button", {
          name: decliningConnection ? "Not now" : "Review request",
          exact: true,
        }),
      ).toBeVisible();
      await input.capture(
        "decision-pending",
        "Request before the user decision",
        "decision-pending.png",
      );
      decisionId = pendingInteraction.id;
      check(
        "decision-request-matches-story",
        true,
        review
          ? "Tool approval belongs to the installed page service."
          : `New connection request is for ${nativeProviderCase ? "Jira" : "Notion"}, without an external-provider question.`,
      );
      if (review)
        check(
          "no-call-before-approval",
          review.invocationCount() === 0,
          "Service must not execute before the user decides.",
        );
      if (decliningConnection) {
        await page
          .getByRole("button", { name: "Not now", exact: true })
          .click();
      } else {
        const dismiss = page.getByRole("button", {
          name: "Dismiss Approve tool action",
        });
        if (await dismiss.isVisible()) await dismiss.click();
        await page
          .getByRole("button", { name: "Review request", exact: true })
          .click();
        await page
          .getByRole("button", {
            name: declining ? "Decline" : "Approve & run",
            exact: true,
          })
          .click();
      }
      const decisionStatus = declining ? "rejected" : "accepted";
      const decided = await pollUntil({
        label: "connection decision persisted",
        deadlineAt: Math.min(input.deadlineAt, Date.now() + 30_000),
        load: () => api.get<Row[]>(`/api/issues/${parent!.id}/interactions`),
        accept: (rows) =>
          rows.some(
            (interaction) =>
              interaction.id === pendingInteraction.id &&
              interaction.status === decisionStatus,
          ),
      });
      decisionResolvedAt = decided.find((i) => i.id === decisionId)?.resolvedAt;
      check(
        "user-decision-persisted",
        true,
        `Interaction ${decisionId} saved as ${decisionStatus}.`,
      );
      note("connection-decision", {
        decision: caseId,
        interactionId: pendingInteraction.id,
        status: decisionStatus,
      });
    }
    await settled(
      caseId === "stop-redirect" ? `Reference ${nonce}`
        : caseId === "provider-second" ? `CONTACTS_${nonce}` : undefined,
    );
    if (caseId === "create-skill-studio") {
      const createdSkills = await api.get<Row[]>(
        `/api/companies/${fixtures.company.id}/skills`,
      );
      const created = createdSkills.find(
        (skill) => skill.slug === "release-readiness-checklist",
      );
      check(
        "skill-persisted",
        Boolean(created && String(created.name) === "release-readiness-checklist"),
        "The runner-created skill is present in the company library after the run.",
      );
      if (created) {
        await openParent();
        const card = page.getByRole("article", {
          name: "Skill created: release-readiness-checklist",
        });
        await expect(card).toHaveCount(1);
        await expect(card).toBeVisible();
        await card.getByRole("button").click();
        await expect(page.getByRole("heading", { name: "release-readiness-checklist" })).toBeVisible();
        await expect(page.getByText("Verify checks.", { exact: true })).toBeVisible();
        check("feed-card-opened", true, "The task thread card opened the created skill sidebar.");
        const openStudio = page.getByRole("button", { name: "Open in Skill Studio", exact: true });
        await expect(openStudio).toBeVisible();
        await openStudio.click();
        await expect(page).toHaveURL(new RegExp(`/skills/studio/${created.id}$`));
        // Studio's skill selector identifies the resource. Headings inside the
        // authored document can differ from its canonical skill name.
        await expect(page.getByRole("combobox").filter({ hasText: "release-readiness-checklist" })).toBeVisible();
        const editor = page.getByRole("textbox", { name: "editable markdown", exact: true });
        await editor.click();
        await editor.press("ControlOrMeta+End");
        await editor.press("Enter");
        await editor.press("Enter");
        await editor.pressSequentially("Studio edit marker: verified");
        await page.getByRole("button", { name: /^Save$/ }).click();
        await pollUntil({
          label: "Skill Studio edit persisted",
          deadlineAt: Math.min(input.deadlineAt, Date.now() + 30_000),
          load: () => api.get<Row>(
            `/api/companies/${fixtures.company.id}/skills/${encodeURIComponent(String(created.id))}`,
          ),
          accept: (detail) => JSON.stringify(detail).includes("Studio edit marker: verified"),
        });
        const detail = await api.get<Row>(
          `/api/companies/${fixtures.company.id}/skills/${encodeURIComponent(String(created.id))}`,
        );
        check(
          "studio-edit-persisted",
          JSON.stringify(detail).includes("Studio edit marker: verified"),
          "The Skill Studio edit remains in the persisted skill after returning to the page.",
        );
        check("studio-opened", true, "The skill detail opened in Skill Studio.");
        await page.goBack();
        await expect(page).toHaveURL(new RegExp(`/issues/`));
        const returnedCard = page.getByRole("article", {
          name: "Skill created: release-readiness-checklist",
        });
        await expect(returnedCard).toBeVisible();
        await returnedCard.getByRole("button").click();
        await expect(page.getByRole("heading", { name: "release-readiness-checklist" })).toBeVisible();
        await expect(page.getByText("Studio edit marker: verified", { exact: true })).toBeVisible();
        check("return-content-persisted", true, "Returning to the task shows the saved Skill Studio edit.");
      }
    }
    if (providerChoice) {
      const issue = ev.issues.find(i=>i.id===parent!.id)!;
      const state = await api.get<{connections:Row[]}>(`/api/companies/${fixtures.company.id}/tools/connections`);
      ev.checks.push(...gradeProviderOutcome({rows:issue.interactions as any, decisionId:decisionId!,
        selected:caseId === "provider-decline" ? "none" : "via:arcade:hubspot", calls:aggregatorFixture?.invocationCount() ?? 0,
        response: (issue.comments ?? []).filter((c:Row)=>c.authorAgentId).map((c:Row)=>c.body).join("\n"), marker:`CONTACTS_${nonce}`,
        sameConnections:isDeepStrictEqual(state.connections.map(c=>c.id).sort(), initialConnections.sort()),
      }));
    }
    if (declining) {
      const issue = ev.issues.find((i) => i.id === parent!.id)!;
      const requests = issue.interactions as Row[];
      check(
        "decline-not-repeated",
        requests.length === 1 &&
          requests[0]?.id === decisionId &&
          requests[0]?.status === "rejected",
        "The saved decline remains rejected and no replacement request appears.",
      );
      const replies = (issue.comments ?? []).filter(
        (c: Row) =>
          c.authorAgentId &&
          Date.parse(c.createdAt) >= Date.parse(decisionResolvedAt ?? ""),
      );
      const text = replies.map((c: Row) => String(c.body ?? "")).join("\n");
      check(
        "decline-visible-explanation",
        replies.length > 0 &&
          /declin|not now|could(?:n.t| not)|cannot|can.t|unable|not (?:connect|retriev)|without (?:access|connect)/i.test(
            text,
          ),
        "A new agent response explains the missing access after the saved decline.",
      );
      check(
        "decline-no-fabricated-result",
        !text.includes(`SERVICE_${nonce}`),
        "The fallback does not claim the private verification code.",
      );
      if (decliningConnection) {
        const state = await api.get<{ connections: Row[] }>(
          `/api/companies/${fixtures.company.id}/tools/connections`,
        );
        check(
          "decline-no-connection-created",
          isDeepStrictEqual(
            state.connections.map((c) => c.id).sort(),
            initialConnections.sort(),
          ),
          "Not now did not create a service connection.",
        );
      }
    }
    if (caseId === "build-revise") {
      await download(parent!.id, "base", "initial");
      await reply(SLUGIFY_REVISION);
      note("revision-requested");
      await settled();
      await download(parent!.id, "separator", "revised");
      check(
        "new-artifact-revision",
        ev.downloads.length === 2 &&
          ev.downloads[0]!.sha256 !== ev.downloads[1]!.sha256,
        "The follow-up must deliver a new version.",
      );
      if (ev.downloads[0]) {
        const response = await api.request.get(
          `/api/attachments/${ev.downloads[0].attachmentId}/content`,
        );
        check(
          "prior-download-preserved",
          response.ok() &&
            createHash("sha256")
              .update(await response.body())
              .digest("hex") === ev.downloads[0].sha256,
          "The first delivered version remains retrievable.",
        );
      }
    } else if (caseId === "hire-reuse") {
      let agents = await api.get<Row[]>(
        `/api/companies/${fixtures.company.id}/agents`,
      );
      const hires = agents.filter((a) => a.name === "Morgan QA");
      check(
        "exactly-one-hire",
        hires.length === 1,
        "One Morgan QA must be hired.",
      );
      check(
        "manager-correct",
        hires.length === 1 && hires[0]!.reportsTo === fixtures.agent.id,
        "The hired agent reports to the lead.",
      );
      const lead = agents.find((a) => a.id === fixtures.agent.id);
      check(
        "hire-native-connection",
        hires.length === 1 &&
          hires[0]!.adapterType === "paperclip_runner" &&
          hires[0]!.adapterConfig?.model === lead?.adapterConfig?.model &&
          isDeepStrictEqual(
            hires[0]!.runtimeConfig?.aiConnection,
            fixtures.aiConnection?.binding,
          ),
        "The hire keeps the native model and inherits the managed AI account binding.",
      );
      const children = ev.issues.filter((i) => i.parentId === parent!.id);
      check(
        "hired-agent-executed",
        hires.length === 1 &&
          ev.runs.some(
            (r) =>
              r.agentId === hires[0]!.id &&
              r.status === "succeeded" &&
              (r.contextSnapshot?.aiConnection as Row | undefined)
                ?.connectionId === fixtures.aiConnection?.connectionId,
          ),
        "The new hire must complete a run using the fixture managed account.",
      );
      await downloadDelegated("base", "hired-delivery");
      const reuseRequestedAt = Date.now();
      await reply(
        `Have the existing Morgan QA add --separator support to the delivered project. Use the same agent; do not hire another. ${SLUGIFY_REVISION}`,
      );
      note("reuse-requested");
      await settled();
      agents = await api.get<Row[]>(
        `/api/companies/${fixtures.company.id}/agents`,
      );
      check(
        "hire-reused",
        agents.filter((a) => a.name === "Morgan QA").length === 1 &&
          agents.some((a) => a.id === hires[0]?.id),
        "The original hired identity remains unique.",
      );
      check(
        "hired-agent-executed-revision",
        ev.runs.some(
          (r) =>
            r.agentId === hires[0]?.id &&
            r.status === "succeeded" &&
            Date.parse(r.finishedAt ?? "") >= reuseRequestedAt,
        ),
        "The same hired agent performs the follow-up work.",
      );
      await downloadDelegated("separator", "reused-delivery", reuseRequestedAt);
    } else if (caseId === "delegate-feedback") {
      const children = ev.issues.filter((i) => i.parentId === parent!.id);
      check(
        "one-child",
        children.length === 1,
        "Exactly one delegated child task.",
      );
      check(
        "child-consumed-feedback",
        Boolean(children[0]) &&
          storyRepliesConsumed(
            ev.runs.filter(
              (run) =>
                run.contextSnapshot?.issueId === children[0]?.id ||
                run.contextSnapshot?.taskId === children[0]?.id,
            ),
            submittedCommentIds,
          ),
        "A completed child execution consumed the delivered user feedback.",
      );
      if (children[0])
        await downloadDelegated(
          artifactGradeModeForPhase("delegated-delivery"),
          "delegated-delivery",
        );
      check(
        "feedback-delivered-to-child",
        Boolean(
          children[0]?.comments?.some((c: Row) =>
            String(c.body).includes("--max-length"),
          ),
        ),
        "The child history contains the late requirement.",
      );
    } else if (caseId === "agent-review-handoff") {
      const children = ev.issues.filter((i) => i.parentId === parent!.id);
      const child = children.find((candidate) =>
        candidate.id === reviewHandoffBoundary?.childId,
      );
      const interaction = storyAcceptedAgentReview(
        child,
        reviewHandoffBoundary?.interactionId,
        fixtures.agent.id,
        ev.runs,
      ) as Row | undefined;
      const reviewRun = interaction?.resolvedByRunId
        ? ev.runs.find((run) => run.id === interaction.resolvedByRunId)
        : undefined;
      const parentContinuationRun = ev.runs.find(
        (run) =>
          run.agentId === fixtures.agent.id &&
          run.status === "succeeded" &&
          run.id !== reviewHandoffBoundary?.parentRunId &&
          (run.nativeIssueId === parent!.id ||
            run.contextSnapshot?.issueId === parent!.id ||
            run.contextSnapshot?.taskId === parent!.id) &&
          interaction?.resolvedAt &&
          run.startedAt &&
          Date.parse(run.startedAt) >= Date.parse(interaction.resolvedAt),
      );
      check(
        "agent-review-one-child",
        children.length === 1 && Boolean(child),
        "Exactly one child remains attached to the lead task.",
      );
      check(
        "agent-review-child-completed",
        child?.status === "done" && interaction?.status === "accepted",
        "The named agent review is accepted and the child reaches Done.",
      );
      check(
        "agent-review-assignee-preserved",
        child?.assigneeAgentId === reviewHandoffBoundary?.assigneeAgentId,
        "Review resolution preserves the child task assignee.",
      );
      check(
        "agent-review-run-scoped",
        reviewRun?.status === "succeeded" &&
          reviewRun.agentId === fixtures.agent.id &&
          reviewRun.contextSnapshot?.nativeReviewInteractionId ===
            interaction?.id &&
          typeof reviewRun.contextSnapshot?.nativeReviewDecisionId === "string",
        "The lead resolves the review from a successful review-scoped native run.",
      );
      check(
        "agent-review-parent-resumed",
        parent?.status === "done" &&
          Boolean(parentContinuationRun) &&
          Boolean(
            parentContinuationRun?.finishedAt &&
              parentContinuationRun.startedAt &&
              Date.parse(parentContinuationRun.finishedAt) >=
                Date.parse(parentContinuationRun.startedAt),
          ),
        "The parent continuation starts after review acceptance and finishes successfully.",
      );
      note("agent-review-accepted", {
        childId: child?.id,
        childAssigneeAgentId: child?.assigneeAgentId,
        interactionId: interaction?.id,
        interactionStatus: interaction?.status,
        resolvedByRunId: interaction?.resolvedByRunId,
        reviewRunId: reviewRun?.id,
        reviewRunAgentId: reviewRun?.agentId,
        parentContinuationRunId: parentContinuationRun?.id,
        parentContinuationStartedAt: parentContinuationRun?.startedAt,
        nativeReviewInteractionId:
          reviewRun?.contextSnapshot?.nativeReviewInteractionId,
        nativeReviewDecisionId:
          reviewRun?.contextSnapshot?.nativeReviewDecisionId,
      });
      // The review handoff case uses the base slugify requirements. The
      // max-length grader belongs to the later follow-up requirement cases.
      if (child)
        await downloadDelegated(
          artifactGradeModeForPhase("reviewed-delivery"),
          "reviewed-delivery",
        );
    } else if (caseId === "recover-controller")
      await download(
        parent!.id,
        artifactGradeModeForPhase("recovered-delivery"),
        "recovered-delivery",
      );
    else if (caseId === "stop-redirect")
      check(
        "new-direction-delivered",
        settledAgentReply?.authorAgentId === fixtures.agent.id &&
          String(settledAgentReply.body ?? "").includes(`Reference ${nonce}`),
        "The new request is answered after Stop and reload.",
      );
    if (stoppedWorkspace) {
      check(
        "stop.workspace-unchanged",
        isDeepStrictEqual(stoppedWorkspace, await workspaceFiles()),
        "Project files remain unchanged from verified runner stop through the new response.",
      );
      check(
        "stop.no-old-run-active",
        ev.runs
          .filter((r) => ev.allowedInterruptedRuns.includes(r.id))
          .every((r) => !isActiveStoryRun(r)),
        "The stopped run is terminal after the new response.",
      );
    }
    if (review) {
      check(
        "service-call-count",
        review.invocationCount() === (caseId === "service-decline" ? 0 : 1),
        "Exactly one approved service call; none after decline.",
      );
      if (caseId === "service-approve") {
        const docs = await api.get<Row[]>(
          `/api/issues/${parent!.id}/documents`,
        );
        const bodies = await Promise.all(
          docs.map((d) =>
            api.get<Row>(
              `/api/issues/${parent!.id}/documents/${encodeURIComponent(d.key)}`,
            ),
          ),
        );
        const attachments = await api.get<Row[]>(
          `/api/issues/${parent!.id}/attachments`,
        );
        for (const attachment of attachments.filter(
          (a) =>
            /\.(?:md|txt)$/i.test(a.originalFilename ?? a.filename ?? "") ||
            ["text/markdown", "text/plain"].includes(a.contentType),
        )) {
          const url = `/api/attachments/${attachment.id}/content`;
          const response = await api.request.get(url);
          if (!response.ok()) continue;
          await expect(page.locator(`a[href*="${url}"]`).first()).toBeVisible();
          bodies.push({
            id: attachment.id,
            title: attachment.originalFilename ?? attachment.filename,
            body: await response.text(),
            source: "delivered-attachment",
          });
        }
        const text = bodies
          .map((d) => String(d.body ?? d.revision?.body ?? ""))
          .join("\n");
        check(
          "briefing-uses-real-result",
          text.includes(`SERVICE_${nonce}`),
          "A delivered issue document or Markdown attachment contains the actual service verification code.",
        );
        check(
          "briefing-includes-page-titles",
          text.includes("Roadmap") && text.includes("Meeting notes"),
          "The briefing includes both page titles returned by the service.",
        );
        ev.documents = bodies;
        ev.issues.find((i) => i.id === parent!.id)!.documents = bodies;
      }
    }
    await page.reload();
    await refresh();
    check(
      "submitted-replies-consumed",
      storyRepliesConsumed(ev.runs, submittedCommentIds),
      "Every submitted user message appears in a successfully completed native execution input.",
    );
    if (
      caseId === "delegate-feedback" ||
      caseId === "hire-reuse" ||
      caseId === "agent-review-handoff"
    ) {
      check(
        "parent-finishes-after-child",
        storyParentFinishedAfterChildren(
          ev.runs,
          parent!.id,
          fixtures.agent.id,
          ev.issues.filter((i) => i.parentId === parent!.id).map((i) => i.id),
        ),
        "The lead completes only after the final child execution.",
      );
    }
    const expectedModel = execution.profile.model;
    check(
      "native-model-config",
      ev.runs.length > 0 &&
        ev.runs
          .filter((r) => !isStoryWorkspaceDeferral(r))
          .every(
            (r) =>
              (r.runnerProfileJson?.nativeExecutionInput as Row | undefined)
                ?.provider?.model === expectedModel,
          ),
      "Persisted native execution inputs use the selected model; this does not claim provider-side model identity.",
    );
    check(
      "native-terminal-contract",
      ev.runs
        .filter(
          (r) =>
            !isStoryWorkspaceDeferral(r) &&
            !isExpectedStoryInterruption(r, ev.allowedInterruptedRuns),
        )
        .every(
          (r) =>
            (r.resultJson?.nativeTerminal as Row | undefined)?.schema ===
            "paperclip.prp.terminal.v1",
        ),
      "Successful runs retain the native terminal contract.",
    );
    ev.checks.push(
      ...storyLifecycleChecks({
        issues: ev.issues as StoryIssue[],
        runs: ev.runs,
        parentId: parent!.id,
        leadId: fixtures.agent.id,
        allowedInterruptedRuns: ev.allowedInterruptedRuns,
      }),
    );
    check(
      "no-pending-bookkeeping",
      ev.issues.every((i) =>
        (i.interactions ?? []).every((x: Row) => x.status !== "pending"),
      ),
      "No completion confirmation or unanswered interaction remains.",
    );
    if (providerChoice || nativeProviderCase) await openParent();
    else await waitForTaskChatRendered(page, String(parent!.title));
    const latestAgentComment = ev.issues
      .find((i) => i.id === parent!.id)
      ?.comments?.filter((c: Row) => c.authorAgentId)
      .at(-1);
    if (latestAgentComment && !providerChoice && !nativeProviderCase) {
      const response = page.locator(`[id="comment-${latestAgentComment.id}"]`);
      await expect(response).toBeVisible();
      await response.scrollIntoViewIfNeeded();
    }
    await input.capture(
      "final-state",
      "Finished everyday workflow",
      "final-state.png",
    );
    const failed = ev.checks.filter((c) => !c.passed);
    if (failed.length)
      throw new Error(
        `Everyday outcome checks failed: ${failed.map((c) => c.id).join(", ")}`,
      );
    return { issue: parent!, runs: ev.runs, evidence: ev };
  } catch (error) {
    check(
      error instanceof StoryDecisionError
        ? error.checkId
        : "workflow-completed",
      false,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  } finally {
    try {
      await refresh();
      ev.agents = await api.get<Row[]>(
        `/api/companies/${fixtures.company.id}/agents`,
      );
      if (ev.documents && parent)
        ev.issues.find((i) => i.id === parent!.id)!.documents = ev.documents;
    } catch (error) {
      note("evidence-capture-error", String(error));
    }
    if (caseId === "recover-controller") {
      note("recovery-final-observation", {
        taskStatus: parent?.status,
        pendingCommentIds: ev.issues.flatMap((i) =>
          (i.queuedComments?.entries ?? []).map((e: Row) => e.comment.id),
        ),
        failureCodes: ev.runs
          .filter((r) => r.errorCode)
          .map((r) => ({ runId: r.id, code: r.errorCode })),
      });
      if (execution.environment.id === "local") {
        try {
          const source = await readFile(
            path.join(input.workspacePath, "slugify.py"),
            "utf8",
          );
          await input.evidence("source-after-interruption.json", {
            body: source,
            sha256: createHash("sha256").update(source).digest("hex"),
          });
        } catch {
          note("saved-source-unavailable-at-final-capture");
        }
      }
    }
    if (review) {
      note("service-final-observation", {
        invocationCount: review.invocationCount(),
        requests: review.captures,
        decisionTaken: ev.timeline.some(
          (entry) => entry.action === "connection-decision",
        ),
      });
    }
    try {
      await input.evidence("everyday-workflow.json", ev);
      await input.evidence("api-state.json", {
        capturePhase: "everyday-final", issue: parent, runs: ev.runs,
        issues: ev.issues, checks: ev.checks,
      });
      if (aggregatorFixture) await input.evidence("aggregator-provider-calls.json", { calls: aggregatorFixture.captures });
    } finally {
      try { await aggregatorFixture?.close(); }
      finally { await review?.close(); }
    }
  }
}
