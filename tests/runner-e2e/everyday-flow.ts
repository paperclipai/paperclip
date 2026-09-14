import { expect, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pollUntil, type RunnerApi } from "./api.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";
import { createTaskThroughUi, submitTaskReply } from "./user-actions.js";
import { setupConnectionReview } from "./connection-reviews.js";
import { LATE_REQUIREMENT, SLUGIFY_REVISION } from "./everyday-cases.js";
import {
  isActiveStoryRun,
  isStoryWorkspaceDeferral,
  storyLifecycleChecks,
  storyRepliesConsumed,
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
  async function openParent() {
    await page.goto(taskUrl(parent!), { waitUntil: "domcontentloaded" });
  }
  async function reply(message: string) {
    const before = await api.get<Row[]>(`/api/issues/${parent!.id}/comments`);
    lastSubmissionAt = Date.now();
    await submitTaskReply(page, message);
    const after = await pollUntil({
      label: "one persisted user reply",
      deadlineAt: Date.now() + 30_000,
      load: () => api.get<Row[]>(`/api/issues/${parent!.id}/comments`),
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
    note("composer-message-persisted", { commentIds: added.map((c) => c.id) });
  }
  async function settled() {
    await pollUntil({
      label: `everyday ${caseId} settled`,
      deadlineAt: input.deadlineAt,
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
        ),
      reject: (state) => {
        if (state.runs.length > 12) return "bounded execution count exceeded";
        const bad = state.runs.find(
          (r) =>
            ["failed", "timed_out"].includes(r.status) &&
            !ev.allowedInterruptedRuns.includes(r.id),
        );
        if (bad)
          return `native execution failed ${bad.errorCode ?? ""}: ${bad.error ?? bad.status}`;
        if (
          state.runs.some(isActiveStoryRun) ||
          state.issues.some((i) => i.scheduledRetry || i.activeRecoveryAction)
        )
          return;
        if (
          state.runs.length &&
          state.issues.some((i) => i.status === "blocked")
        )
          return "task is Blocked without an active continuation";
        if (
          state.issues.some(
            (i) =>
              i.status === "in_review" &&
              i.interactions.some((x: Row) => x.status === "pending"),
          )
        )
          return "unexpected human interaction: task did not finish autonomously";
      },
    });
    await openParent();
    await expect(
      page.getByTestId("issue-detail-header").getByRole("button", {
        name: "Change status (current: Done)",
        exact: true,
      }),
    ).toBeVisible();
    note("all-tasks-done");
  }
  async function download(
    issueId: string,
    mode: "base" | "separator" | "max-length",
    phase: string,
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
    const attachment = zips[zips.length - 1]!;
    const issue = ev.issues.find((i) => i.id === issueId)!;
    await page.goto(taskUrl(issue), { waitUntil: "domcontentloaded" });
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
    ]);
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
  async function sourceReady() {
    await pollUntil({
      label: "saved source before interruption",
      deadlineAt: Math.min(input.deadlineAt, Date.now() + 180_000),
      intervalMs: 500,
      load: async () => {
        await refresh();
        try {
          return (
            (await stat(path.join(input.workspacePath, "slugify.py"))).size >
              0 && ev.runs.some(isActiveStoryRun)
          );
        } catch {
          return false;
        }
      },
      accept: Boolean,
    });
    const bytes = await readFile(path.join(input.workspacePath, "slugify.py"));
    await input.evidence("source-before-interruption.json", {
      body: bytes.toString("utf8"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    note("source-saved-before-interruption", {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
  }
  try {
    await mkdir(path.join(input.privateDir, "snapshots"), { recursive: true });
    const revision = await runCommand("git", ["rev-parse", "HEAD"]);
    if (revision.code === 0) ev.sourceRevision = revision.stdout.trim();
    const version = await runCommand(
      execution.profile.provider === "acpx" ? "claude" : "codex",
      ["--version"],
    );
    if (version.code === 0) ev.providerVersion = version.stdout.trim();
    const harnessFiles = [
      "everyday-flow.ts",
      "everyday-cases.ts",
      "everyday-observations.ts",
      "everyday-artifact.py",
      "user-actions.ts",
      "runner.spec.ts",
      "api.ts",
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
    if (!project && !caseId.startsWith("service-")) {
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
    if (caseId === "delegate-feedback") {
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
      });
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
      });
      const child = ev.issues.find((i) => i.parentId === parent!.id)!;
      note("late-feedback-boundary", {
        childId: child.id,
        activeRunIds: ev.runs.filter(isActiveStoryRun).map((r) => r.id),
      });
      await reply(
        `Please pass this addition to Riley on the existing child task, using a progress comment here that mentions Riley and links ${child.identifier}. ${LATE_REQUIREMENT}`,
      );
      note("late-feedback-submitted");
    }
    if (
      caseId === "recover-controller" ||
      caseId === "recover-runner" ||
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
      } else await sourceReady();
      const active = ev.runs.find((r) => r.status === "running");
      if (!active)
        throw new Error(
          "Fault boundary was not exercised: no active execution",
        );
      if (caseId === "stop-redirect") {
        await page.getByTestId("task-chat-composer-stop").last().click();
        ev.allowedInterruptedRuns.push(active.id);
        note("stop-clicked", { runId: active.id });
        await reply(
          `Change direction. Leave the project as it is. Reply with just this short note: "The studio is ready. Reference ${nonce}."`,
        );
        note("new-direction-submitted");
        await page.reload();
      } else {
        await reply(LATE_REQUIREMENT);
        note("followup-submitted-before-interruption");
        ev.allowedInterruptedRuns.push(active.id);
        if (caseId === "recover-controller") {
          await input.restart();
          note("controller-restarted");
        } else {
          // Only kill a native daemon belonging to this isolated run. Never infer ownership from PID alone.
          const detailed = await api.get<StoryRun>(
            `/api/heartbeat-runs/${active.id}`,
          );
          const pid = detailed.processPid;
          if (!pid || pid < 2 || detailed.runtimeMode !== "native")
            throw new Error(
              "Fault boundary unexercised: no owned native runner PID",
            );
          const identity = await runCommand("ps", [
            "-p",
            String(pid),
            "-o",
            "command=",
          ]);
          const ownedIdentity =
            identity.stdout.includes(`--run-id ${active.id} `) &&
            identity.stdout.includes(
              `--runner-id ${detailed.runnerInstanceId} `,
            );
          const isolatedRoot = path.dirname(input.workspacePath);
          if (
            identity.code !== 0 ||
            !identity.stdout.includes("paperclip-runnerd") ||
            !identity.stdout.includes(`--state-dir ${isolatedRoot}/`) ||
            !ownedIdentity
          )
            throw new Error(
              "Fault boundary unexercised: runner process ownership could not be proven",
            );
          process.kill(pid, "SIGKILL");
          note("owned-runner-killed", { runId: active.id, pid });
        }
        await openParent();
      }
    }
    if (review) {
      await pollUntil({
        label: "connection approval",
        deadlineAt: input.deadlineAt,
        load: () => api.get<Row[]>(`/api/issues/${parent!.id}/interactions`),
        accept: (rows) => rows.some((i) => i.status === "pending"),
      });
      check(
        "no-call-before-approval",
        review.invocationCount() === 0,
        "Service must not execute before the user decides.",
      );
      await openParent();
      await input.capture(
        "tool-review-pending",
        "Connection request before the decision",
        "tool-review-pending.png",
      );
      const dismiss = page.getByRole("button", {
        name: "Dismiss Approve tool action",
      });
      if (await dismiss.isVisible()) await dismiss.click();
      await page
        .getByRole("button", { name: "Review request", exact: true })
        .click();
      await page
        .getByRole("button", {
          name: caseId === "service-decline" ? "Decline" : "Approve & run",
          exact: true,
        })
        .click();
      note("connection-decision", { decision: caseId });
    }
    await settled();
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
          JSON.stringify(hires[0]!.adapterConfig?.env) ===
            JSON.stringify(lead?.adapterConfig?.env),
        "The hire keeps the native model and encrypted connection bindings.",
      );
      const children = ev.issues.filter((i) => i.parentId === parent!.id);
      check(
        "hired-agent-executed",
        hires.length === 1 && ev.runs.some((r) => r.agentId === hires[0]!.id),
        "The new hire must perform real work.",
      );
      if (children[0]) await download(children[0].id, "base", "hired-delivery");
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
      const latestChildren = ev.issues.filter((i) => i.parentId === parent!.id);
      for (const child of latestChildren.slice(-1))
        await download(child.id, "separator", "reused-delivery");
    } else if (caseId === "delegate-feedback") {
      const children = ev.issues.filter((i) => i.parentId === parent!.id);
      check(
        "one-child",
        children.length === 1,
        "Exactly one delegated child task.",
      );
      if (children[0])
        await download(children[0].id, "max-length", "delegated-delivery");
      check(
        "feedback-forwarded",
        Boolean(
          children[0]?.comments.some((c: Row) =>
            String(c.body).includes("--max-length"),
          ),
        ),
        "The child history contains the late requirement.",
      );
    } else if (caseId.startsWith("recover-"))
      await download(parent!.id, "max-length", "recovered-delivery");
    else if (caseId === "stop-redirect")
      check(
        "new-direction-delivered",
        ev.issues
          .find((i) => i.id === parent!.id)
          ?.comments.some(
            (c: Row) =>
              c.authorAgentId && String(c.body).includes(`Reference ${nonce}`),
          ) ?? false,
        "The new request is answered after Stop and reload.",
      );
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
            !ev.allowedInterruptedRuns.includes(r.id),
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
        i.interactions.every((x: Row) => x.status !== "pending"),
      ),
      "No completion confirmation or unanswered interaction remains.",
    );
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
      "workflow-completed",
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
    if (caseId.startsWith("recover-")) {
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
    await input.evidence("everyday-workflow.json", ev);
    await input.evidence("api-state.json", {
      capturePhase: "everyday-final",
      issue: parent,
      runs: ev.runs,
      issues: ev.issues,
      checks: ev.checks,
    });
    await review?.close();
  }
}
