import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { RunnerApi, pollUntil } from "./api.js";
import { buildRuntimeUsage, summarizeExecutionBilling } from "./billing.js";
import { runnerExecutionById } from "./catalog.js";
import { classifyFailure } from "./failure-classifier.js";
import { runnerE2EServerControlPaths } from "./harness-env.js";
import { setupLiveFixtures, type LiveFixtureValues } from "./live-fixtures.js";
import { evaluateMatcher, type MatcherResult } from "./matchers.js";
import {
  acceptedPlanSessionResetFailures,
  hasTerminalMalformedPlanConfirmation,
  isControlPlaneGovernedResponseWait,
  isNonExecutingReviewFenceRun,
  isOpenRouterDeepSeekHelloTerminalVariance,
  numberedPlanStepCount,
  providerSessionContinuityFailures,
} from "./run-observations.js";
import { resolveRunnerE2ESource } from "./source.js";
import {
  isPublicRunnerScreenshotRoute,
  PUBLIC_RUNNER_SCREENSHOT_MARKER,
} from "./screenshot-policy.js";
import {
  assertSecretFree,
  findSecretLeakInJsonValues,
  normalizedSecrets,
  sanitizeJson,
} from "./redaction.js";
import {
  CREDENTIAL_NAMES,
  type CredentialName,
  type FailureClass,
  type RunnerE2EResult,
} from "./types.js";

interface IssueRecord {
  id: string;
  identifier?: string | null;
  companyId: string;
  title: string;
  status: string;
  workMode?: string;
  assigneeAgentId?: string | null;
  executionRunId?: string | null;
  checkoutRunId?: string | null;
}

interface CommentRecord {
  id: string;
  body?: string | null;
  authorType?: string | null;
  authorAgentId?: string | null;
  createdByRunId?: string | null;
  createdAt?: string;
}

interface RunRecord {
  id: string;
  companyId: string;
  agentId: string;
  status: string;
  runtimeMode?: string;
  continuationAttempt?: number;
  retryOfRunId?: string | null;
  runnerInstanceId?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
  runnerProfileJson?: Record<string, unknown> | null;
  usageJson?: Record<string, unknown> | null;
  resultJson?: Record<string, unknown> | null;
  sessionIdBefore?: string | null;
  sessionIdAfter?: string | null;
  error?: string | null;
  errorCode?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

interface EnvironmentLeaseRecord {
  id: string;
  issueId?: string | null;
  heartbeatRunId?: string | null;
  provider?: string | null;
  acquiredAt?: string | null;
  releasedAt?: string | null;
  updatedAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface InteractionRecord {
  id: string;
  status: string;
  kind?: string;
  payload?: {
    version?: number;
    acceptLabel?: string;
    rejectLabel?: string;
    target?: {
      type?: string;
      key?: string;
      revisionId?: string;
      revisionNumber?: number;
    };
    questions?: Array<{
      id: string;
      prompt: string;
      selectionMode: "single" | "multi";
      required?: boolean;
      options: Array<{ id: string; label: string }>;
    }>;
  };
  result?: {
    version?: number;
    answers?: Array<{
      questionId?: string;
      optionIds?: string[];
      otherText?: string;
    }>;
  } | null;
}
interface IssueDocumentRecord {
  id: string;
  key: string;
  body?: string | null;
  latestRevisionId?: string | null;
  latestRevisionNumber?: number;
}
interface RunEventRecord {
  seq?: number;
  eventType?: string;
  payload?: Record<string, unknown> | null;
  sourceInstanceId?: string | null;
  sourceEventId?: string | null;
  sourceSeq?: number | null;
  protocolSchemaVersion?: number | null;
}
const TERMINAL_RUN_STATUSES = new Set([
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
]);
const DEFINITIVE_FAILURE_RUN_STATUSES = new Set([
  "failed",
  "cancelled",
  "timed_out",
]);

function definitiveRunFailure(runs: readonly RunRecord[]) {
  const failed = runs.find((run) =>
    DEFINITIVE_FAILURE_RUN_STATUSES.has(run.status),
  );
  if (!failed) return undefined;
  return `heartbeat run ${failed.id} ended ${failed.status}${failed.errorCode ? ` (${failed.errorCode})` : ""}${failed.error ? `: ${failed.error}` : ""}`;
}

function chronologicalRunTime(run: RunRecord): number {
  const value = run.startedAt ?? run.finishedAt;
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sortRunsChronologically(runs: readonly RunRecord[]): RunRecord[] {
  return [...runs].sort(
    (left, right) =>
      chronologicalRunTime(left) - chronologicalRunTime(right) ||
      left.id.localeCompare(right.id),
  );
}

async function restartIsolatedPaperclipServer(input: {
  api: RunnerApi;
  requestId: string;
  deadlineAt: number;
}): Promise<void> {
  const {
    controlDirectory,
    restartRequestPath: requestPath,
    restartAcknowledgementPath: acknowledgementPath,
  } = runnerE2EServerControlPaths(temporaryRoot!);
  await mkdir(controlDirectory, { recursive: true });
  const temporaryRequestPath = `${requestPath}.${process.pid}.${input.requestId}.tmp`;
  await writeFile(
    temporaryRequestPath,
    JSON.stringify({ requestId: input.requestId }),
    { encoding: "utf8", mode: 0o600 },
  );
  await rename(temporaryRequestPath, requestPath);

  await pollUntil({
    label: `isolated server restart ${input.requestId}`,
    deadlineAt: input.deadlineAt,
    intervalMs: 250,
    load: async () => {
      try {
        return JSON.parse(
          await readFile(acknowledgementPath, "utf8"),
        ) as Record<string, unknown>;
      } catch {
        return {};
      }
    },
    accept: (acknowledgement) =>
      acknowledgement.requestId === input.requestId &&
      acknowledgement.status === "ready",
    reject: (acknowledgement) =>
      acknowledgement.requestId === input.requestId &&
      acknowledgement.status === "failed"
        ? String(acknowledgement.message ?? "replacement server failed")
        : undefined,
  });
  await pollUntil({
    label: `replacement server health ${input.requestId}`,
    deadlineAt: input.deadlineAt,
    intervalMs: 250,
    load: () => input.api.get<Record<string, unknown>>("/api/health"),
    accept: (health) => Boolean(health),
  });
}

const executionIds = (() => {
  const encoded = process.env.PAPERCLIP_RUNNER_E2E_EXECUTION_IDS;
  if (encoded) {
    const parsed = JSON.parse(encoded) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.some((value) => typeof value !== "string")
    ) {
      throw new Error(
        "PAPERCLIP_RUNNER_E2E_EXECUTION_IDS must be a non-empty JSON string array",
      );
    }
    return parsed;
  }
  const single = process.env.PAPERCLIP_RUNNER_E2E_EXECUTION_ID;
  if (!single)
    throw new Error("PAPERCLIP_RUNNER_E2E_EXECUTION_IDS is required");
  return [single];
})();
const executions = executionIds.map(runnerExecutionById);
const attempt = Number(process.env.PAPERCLIP_RUNNER_E2E_ATTEMPT ?? "1");
const temporaryRoot = process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT;
const privateRoot = process.env.PAPERCLIP_RUNNER_E2E_PRIVATE_DIR;
const workspacePath = process.env.PAPERCLIP_RUNNER_E2E_WORKSPACE;
if (!temporaryRoot || !privateRoot || !workspacePath)
  throw new Error("Runner E2E temporary/private/workspace paths are required");

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function credentialValues(): Partial<Record<CredentialName, string>> {
  return Object.fromEntries(
    CREDENTIAL_NAMES.flatMap((name) => {
      const value = process.env[name]?.trim();
      return value ? [[name, value]] : [];
    }),
  );
}

async function writeSanitizedJson(
  directory: string,
  name: string,
  value: unknown,
  secrets: readonly string[],
) {
  const raw = `${JSON.stringify(value)}\n`;
  // Public API payloads may contain harmless provider-shaped fixtures or
  // opaque generated tokens. Reject exact campaign credentials before writing,
  // then sanitize all known shapes and assert the published JSON is clean.
  assertSecretFree(raw, secrets, name, { includeShapes: false });
  const safe = `${JSON.stringify(sanitizeJson(value, secrets), null, 2)}\n`;
  const leak = findSecretLeakInJsonValues(JSON.parse(safe), secrets);
  if (leak) throw new Error(`Secret leak in ${name}: ${leak}`);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, name), safe, "utf8");
}

async function createTaskThroughUi(input: {
  page: Page;
  issuePrefix: string;
  agentName: string;
  title: string;
  prompt: string;
  workMode: "standard" | "planning" | "ask";
}) {
  const issuesUrl = `/${encodeURIComponent(input.issuePrefix)}/issues`;
  const newTask = input.page.getByRole("button", { name: "New Task" }).first();
  let bootstrapError: unknown;
  for (let bootstrapAttempt = 1; bootstrapAttempt <= 3; bootstrapAttempt += 1) {
    try {
      await input.page.goto(issuesUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await newTask.waitFor({ state: "visible", timeout: 20_000 });
      bootstrapError = undefined;
      break;
    } catch (error) {
      bootstrapError = error;
      if (bootstrapAttempt < 3) await input.page.waitForTimeout(1_000);
    }
  }
  if (bootstrapError) {
    throw new Error(
      `Browser bootstrap failed before task creation: ${bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError)}`,
      { cause: bootstrapError },
    );
  }
  await newTask.click();
  await input.page.getByPlaceholder("Task title").fill(input.title);
  await input.page
    .getByRole("dialog")
    .getByRole("textbox", { name: "editable markdown", exact: true })
    .fill(input.prompt);
  if (input.workMode !== "standard") {
    await input.page
      .getByRole("dialog")
      .locator(`[data-issue-work-mode-chip="standard"]`)
      .click();
    await input.page
      .locator(`[data-issue-work-mode="${input.workMode}"]`)
      .click();
  }
  await input.page
    .getByRole("button", { name: "Assignee", exact: true })
    .click();
  await input.page
    .getByPlaceholder("Search assignees...")
    .fill(input.agentName);
  await input.page.getByText(input.agentName, { exact: true }).last().click();
  await input.page
    .getByRole("button", { name: "Create Task", exact: true })
    .click();
}

function matchingRuns(runs: RunRecord[], issue: IssueRecord) {
  const explicit = new Set(
    [issue.executionRunId, issue.checkoutRunId].filter(Boolean),
  );
  return runs.filter((run) => {
    if (isNonExecutingReviewFenceRun(run)) return false;
    const context = record(run.contextSnapshot);
    return (
      context.issueId === issue.id ||
      context.taskId === issue.id ||
      explicit.has(run.id)
    );
  });
}

function isPendingPlanConfirmation(interaction: InteractionRecord) {
  return (
    interaction.kind === "request_confirmation" &&
    interaction.status === "pending" &&
    interaction.payload?.target?.type === "issue_document" &&
    interaction.payload.target.key === "plan" &&
    typeof interaction.payload.target.revisionId === "string"
  );
}

function isPendingQuestion(interaction: InteractionRecord) {
  return (
    interaction.kind === "ask_user_questions" &&
    interaction.status === "pending" &&
    Boolean(interaction.payload?.questions?.length)
  );
}

function normalizePlanMarkdown(body: string | null | undefined) {
  // Provider plan renderers may defensively escape underscores in plain-text
  // markers. The rendered document and semantic marker are identical.
  return (body ?? "").replaceAll("\\_", "_");
}

function nativeRunEventIntegrityFailures(
  run: RunRecord,
  events: readonly RunEventRecord[],
): string[] {
  const failures: string[] = [];
  let lastOuterSeq = 0;
  const lastSourceSeq = new Map<string, number>();
  const sourceEventIds = new Set<string>();
  const runnerEventTypes: string[] = [];
  const runTerminalSources: unknown[] = [];
  const resultAcceptedSources: unknown[] = [];

  for (const event of events) {
    if (typeof event.seq !== "number" || event.seq <= lastOuterSeq) {
      failures.push(
        `run ${run.id} event sequence is not strictly monotonic at ${String(event.seq)}`,
      );
    } else {
      lastOuterSeq = event.seq;
    }
    const envelope = record(event.payload?.prpEvent);
    if (Object.keys(envelope).length === 0) continue;
    if (
      envelope.schema !== "paperclip.prp.event.v1" ||
      envelope.schemaVersion !== 1 ||
      event.protocolSchemaVersion !== 1
    ) {
      failures.push(`run ${run.id} exposed a malformed PRP v1 envelope`);
    }
    if (envelope.runId !== run.id) {
      failures.push(
        `run ${run.id} exposed an event bound to ${String(envelope.runId)}`,
      );
    }
    if (envelope.eventType !== event.eventType) {
      failures.push(
        `run ${run.id} event discriminator changed from ${String(event.eventType)} to ${String(envelope.eventType)}`,
      );
    }
    if (
      envelope.sourceInstanceId !== event.sourceInstanceId ||
      envelope.sourceEventId !== event.sourceEventId ||
      envelope.sourceSeq !== event.sourceSeq
    ) {
      failures.push(
        `run ${run.id} event source identity changed during persistence/redaction`,
      );
    }
    if (typeof event.sourceEventId === "string") {
      if (sourceEventIds.has(event.sourceEventId)) {
        failures.push(
          `run ${run.id} duplicated source event ${event.sourceEventId}`,
        );
      }
      sourceEventIds.add(event.sourceEventId);
    }
    if (
      typeof event.sourceInstanceId === "string" &&
      typeof event.sourceSeq === "number"
    ) {
      const previous = lastSourceSeq.get(event.sourceInstanceId) ?? 0;
      if (event.sourceSeq <= previous) {
        failures.push(
          `run ${run.id} source ${event.sourceInstanceId} sequence regressed from ${previous} to ${event.sourceSeq}`,
        );
      }
      lastSourceSeq.set(event.sourceInstanceId, event.sourceSeq);
    }
    if (
      envelope.sourceKind === "runner" &&
      typeof event.eventType === "string"
    ) {
      runnerEventTypes.push(event.eventType);
    }
    if (event.eventType === "run.terminal") {
      runTerminalSources.push(envelope.sourceKind);
    }
    if (event.eventType === "run.result.accepted") {
      resultAcceptedSources.push(envelope.sourceKind);
    }
  }

  const runnerResultCount = runnerEventTypes.filter(
    (value) => value === "run.result.proposed",
  ).length;
  if (
    runnerResultCount !== 1 &&
    !(runnerResultCount === 0 && isControlPlaneGovernedResponseWait(events))
  ) {
    failures.push(
      `run ${run.id} must persist exactly one runner semantic result`,
    );
  }
  if (resultAcceptedSources.length !== 1) {
    failures.push(
      `run ${run.id} must persist exactly one accepted semantic result`,
    );
  } else if (resultAcceptedSources[0] !== "control_plane") {
    failures.push(
      `run ${run.id} accepted semantic result must be control-plane authoritative`,
    );
  }
  if (runTerminalSources.length !== 1) {
    failures.push(`run ${run.id} must persist exactly one terminal event`);
  } else if (runTerminalSources[0] !== "control_plane") {
    failures.push(
      `run ${run.id} terminal event must be control-plane authoritative`,
    );
  }
  return failures;
}

async function expectPlanStageVisible(
  page: Page,
  options: { native: boolean; revision: number | null },
) {
  // A Plan flow is only qualified when the canonical saved document is
  // projected as a card. Native profiles additionally require that card to be
  // inside the runner turn, which proves write-boundary embedding rather than
  // a standalone fallback. The API assertions own exact body-marker identity
  // because the compact card intentionally shows only its first three lines.
  const root = options.native
    ? page.locator('[data-testid="task-chat-turn"][data-settled="true"]')
    : page.locator("body");
  const preview = root.getByTestId("task-chat-plan-preview").last();
  await expect(preview).toBeVisible({ timeout: 30_000 });
  if (options.revision !== null) {
    await expect(preview).toHaveAttribute(
      "aria-label",
      `Open Plan revision ${options.revision}`,
    );
  }
}

for (const execution of executions) {
  const privateDir = path.join(privateRoot, "cases", execution.task.id);
  const resultPath = path.join(privateDir, "result.json");
  const snapshotsDir = path.join(privateDir, "snapshots");
  const deadlineMs = execution.task.attemptTimeoutMs[execution.environment.id];

  test(`${execution.id} completes through the browser and public APIs`, async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(deadlineMs + 90_000);
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const nonce = `${randomBytes(6).toString("hex")}-${attempt}`;
    const marker = execution.task.buildVisibleMarker(nonce);
    const title = execution.task.buildTitle(nonce);
    const prompt = execution.task.buildPrompt(nonce);
    const credentials = credentialValues();
    const secrets = normalizedSecrets(Object.values(credentials));
    const api = new RunnerApi(request);
    const consoleDiagnostics: Array<Record<string, unknown>> = [];
    const networkDiagnostics: Array<Record<string, unknown>> = [];
    let fixtures: LiveFixtureValues | undefined;
    let issue: IssueRecord | undefined;
    let selectedRuns: RunRecord[] = [];
    let runtimeLeases: EnvironmentLeaseRecord[] = [];
    let matcherResults: MatcherResult[] = [];
    const screenshots: NonNullable<RunnerE2EResult["screenshots"]> = [];
    let primaryError: unknown;
    let failureClassOverride: FailureClass | undefined;
    let cleanup: RunnerE2EResult["cleanup"] = "not_started";

    const capturePrivateScreenshot = async (
      id: string,
      file: string,
    ) => {
      const screenshotPath = path.join(privateDir, file);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await testInfo.attach(id, {
        path: screenshotPath,
        contentType: "image/png",
      });
    };

    const isReviewedFixtureScreenshotRoute = () =>
      isPublicRunnerScreenshotRoute(page.url(), {
        issuePrefix: fixtures?.company.issuePrefix,
        issueId: issue?.id,
        issueIdentifier: issue?.identifier,
      });

    const captureScreenshot = async (
      id: string,
      label: string,
      file: string,
    ) => {
      if (!isReviewedFixtureScreenshotRoute()) {
        throw new Error(
          `Public runner screenshot blocked on non-task route ${page.url()}`,
        );
      }
      await capturePrivateScreenshot(id, file);
      screenshots.push({
        id,
        label,
        file,
        publication: PUBLIC_RUNNER_SCREENSHOT_MARKER,
      });
    };

    const captureRuntimeLeases = async () => {
      if (!fixtures || execution.environment.id !== "daytona") return;
      const listed = await api.get<EnvironmentLeaseRecord[]>(
        `/api/environments/${fixtures.environment.id}/leases`,
      );
      const selectedRunIds = new Set(selectedRuns.map((run) => run.id));
      const relevant = listed.filter(
        (lease) =>
          lease.provider === "daytona" &&
          (selectedRunIds.size === 0 ||
            (lease.heartbeatRunId &&
              selectedRunIds.has(lease.heartbeatRunId)) ||
            (issue && lease.issueId === issue.id)),
      );
      runtimeLeases = relevant.length > 0 ? relevant : listed;
    };

    const captureFailureApiState = async () => {
      if (!fixtures || !issue) return;
      const capture = async <T>(operation: () => Promise<T>) =>
        operation().catch((error) => ({
          evidenceCaptureError:
            error instanceof Error ? error.message : String(error),
        }));
      const [currentIssue, listedRuns, comments, interactions] =
        await Promise.all([
          capture(() => api.get<IssueRecord>(`/api/issues/${issue!.id}`)),
          capture(() =>
            api.get<RunRecord[]>(
              `/api/companies/${fixtures!.company.id}/heartbeat-runs?agentId=${fixtures!.agent.id}&limit=20`,
            ),
          ),
          capture(() =>
            api.get<CommentRecord[]>(
              `/api/issues/${issue!.id}/comments?order=asc`,
            ),
          ),
          capture(() =>
            api.get<InteractionRecord[]>(
              `/api/issues/${issue!.id}/interactions`,
            ),
          ),
        ]);
      const taskRuns = Array.isArray(listedRuns)
        ? matchingRuns(listedRuns, "id" in currentIssue ? currentIssue : issue)
        : [];
      const detailedRuns = await Promise.all(
        taskRuns.map((candidate) =>
          capture(() =>
            api.get<RunRecord>(`/api/heartbeat-runs/${candidate.id}`),
          ).then((value) => ("id" in value ? value : candidate)),
        ),
      );
      if (detailedRuns.length > 0) selectedRuns = detailedRuns;
      const runEvidence = await Promise.all(
        detailedRuns.map(async (candidate) => ({
          runId: candidate.id,
          log: await capture(() =>
            api.get<unknown>(
              `/api/heartbeat-runs/${candidate.id}/log?limitBytes=1048576`,
            ),
          ),
          events: await capture(() =>
            api.get<RunEventRecord[]>(
              `/api/heartbeat-runs/${candidate.id}/events?limit=1000`,
            ),
          ),
        })),
      );
      await writeSanitizedJson(
        snapshotsDir,
        "api-state.json",
        {
          capturePhase: "failure",
          issue: currentIssue,
          runs: detailedRuns,
          comments,
          interactions,
          runEvidence,
        },
        secrets,
      );
    };

    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        consoleDiagnostics.push({
          type: message.type(),
          text: message.text(),
          location: message.location(),
        });
      }
    });
    page.on("requestfailed", (requestEvent) => {
      networkDiagnostics.push({
        method: requestEvent.method(),
        url: requestEvent.url(),
        failure: requestEvent.failure()?.errorText ?? null,
      });
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        networkDiagnostics.push({
          method: response.request().method(),
          url: response.url(),
          status: response.status(),
          statusText: response.statusText(),
        });
      }
    });

    try {
      const initialExperimental = await api.get<{
        enableNativeRunner: boolean;
      }>("/api/instance/settings/experimental");
      expect(initialExperimental.enableNativeRunner).toBe(false);
      await api.patch("/api/instance/settings/experimental", {
        enableNativeRunner: true,
        ...(execution.profile.generation === "native" &&
        execution.environment.id === "daytona"
          ? { enableRunnerPreviewIngress: true }
          : {}),
      });

      fixtures = await setupLiveFixtures({
        api,
        execution,
        executionNonce: nonce,
        workspacePath,
        credentials,
        daytonaImage: process.env.PAPERCLIP_E2E_DAYTONA_IMAGE,
      });

      await writeSanitizedJson(
        snapshotsDir,
        "fixtures.json",
        {
          executionId: execution.id,
          companyId: fixtures.company.id,
          environmentId: fixtures.environment.id,
          agentId: fixtures.agent.id,
          secretIds: Object.fromEntries(
            Object.entries(fixtures.secretRefs).map(([name, ref]) => [
              name,
              ref?.secretId,
            ]),
          ),
          persistedAgent: await api.get<unknown>(
            `/api/agents/${fixtures.agent.id}`,
          ),
          persistedEnvironment: await api.get<unknown>(
            `/api/environments/${fixtures.environment.id}`,
          ),
        },
        secrets,
      );

      const issuePrefix = fixtures.company.issuePrefix;
      if (!issuePrefix)
        throw new Error(
          "Created fixture company did not return an issue prefix",
        );
      await createTaskThroughUi({
        page,
        issuePrefix,
        agentName: fixtures.agent.name,
        title,
        prompt,
        workMode: execution.task.workMode,
      });

      const deadlineAt = startedAtMs + deadlineMs;
      issue = await pollUntil({
        label: `UI-created issue ${title}`,
        deadlineAt,
        load: async () => {
          const issues = await api.get<IssueRecord[]>(
            `/api/companies/${fixtures!.company.id}/issues?q=${encodeURIComponent(title)}&limit=50`,
          );
          return issues.find((candidate) => candidate.title === title);
        },
        accept: (candidate): candidate is IssueRecord => Boolean(candidate),
      });
      if (!issue) throw new Error(`Issue ${title} disappeared after creation`);
      if (
        issue.companyId !== fixtures.company.id ||
        issue.assigneeAgentId !== fixtures.agent.id
      ) {
        throw new Error(
          "UI-created issue does not belong to the fixture company and agent",
        );
      }
      if (issue.workMode !== execution.task.workMode) {
        throw new Error(
          `UI-created issue work mode was ${String(issue.workMode)}; expected ${execution.task.workMode}`,
        );
      }

      await page.goto(
        `/${encodeURIComponent(issuePrefix)}/issues/${encodeURIComponent(issue.identifier ?? issue.id)}`,
      );

      const loadTaskState = async () => {
        const [currentIssue, runs, comments, interactions] = await Promise.all([
          api.get<IssueRecord>(`/api/issues/${issue!.id}`),
          api.get<RunRecord[]>(
            `/api/companies/${fixtures!.company.id}/heartbeat-runs?agentId=${fixtures!.agent.id}&limit=20`,
          ),
          api.get<CommentRecord[]>(
            `/api/issues/${issue!.id}/comments?order=asc`,
          ),
          api.get<InteractionRecord[]>(`/api/issues/${issue!.id}/interactions`),
        ]);
        return {
          currentIssue,
          taskRuns: matchingRuns(runs, currentIssue),
          comments,
          interactions,
        };
      };

      const rejectPlanConfirmationPoll = (input: {
        taskRuns: RunRecord[];
        interactions: InteractionRecord[];
        minimumRunCount: number;
      }) => {
        const runFailure = definitiveRunFailure(input.taskRuns);
        if (runFailure) return runFailure;
        if (
          !hasTerminalMalformedPlanConfirmation({
            runs: input.taskRuns,
            interactions: input.interactions,
            minimumRunCount: input.minimumRunCount,
          })
        ) {
          return undefined;
        }
        failureClassOverride = "provider_variance";
        return "succeeded heartbeat run created a pending request_confirmation without a revision-bound Plan target";
      };

      let planLifecycleEvidence: Record<string, unknown> | null = null;
      let questionLifecycleEvidence: Record<string, unknown> | null = null;
      let expectedQuestionResolution: {
        interactionId: string;
        optionId: string;
      } | null = null;
      if (execution.task.flow === "plan_revision_acceptance") {
        const planMarkers = execution.task.buildPlanMarkers?.(nonce);
        const revisionRequest = execution.task.buildRevisionRequest?.(nonce);
        if (!planMarkers || !revisionRequest) {
          throw new Error(
            `Plan fixture ${execution.task.id} is missing lifecycle factories`,
          );
        }
        const draftState = await pollUntil({
          label: `initial plan confirmation for issue ${issue.id}`,
          deadlineAt,
          load: loadTaskState,
          accept: ({ taskRuns, interactions }) =>
            taskRuns.length >= 1 &&
            taskRuns.every((run) => TERMINAL_RUN_STATUSES.has(run.status)) &&
            interactions.some(isPendingPlanConfirmation),
          reject: ({ taskRuns, interactions }) =>
            rejectPlanConfirmationPoll({
              taskRuns,
              interactions,
              minimumRunCount: 1,
            }),
        });
        const draftInteraction = draftState.interactions.find(
          isPendingPlanConfirmation,
        )!;
        const draftPlan = await api.get<IssueDocumentRecord>(
          `/api/issues/${issue.id}/documents/plan`,
        );
        if (
          !normalizePlanMarkdown(draftPlan.body).includes(planMarkers.draft)
        ) {
          throw new Error(
            `Initial Plan document did not contain ${planMarkers.draft}`,
          );
        }
        if (numberedPlanStepCount(draftPlan.body) !== 2) {
          throw new Error(
            "Initial Plan must contain exactly two numbered steps",
          );
        }
        if (
          draftInteraction.payload?.target?.revisionId !==
          draftPlan.latestRevisionId
        ) {
          throw new Error(
            "Initial plan confirmation did not target the latest Plan revision",
          );
        }
        await page.goto(
          `/${encodeURIComponent(issuePrefix)}/issues/${encodeURIComponent(issue.identifier ?? issue.id)}`,
          { waitUntil: "domcontentloaded" },
        );
        await expectPlanStageVisible(page, {
          native: execution.profile.expectedRuntimeMode === "native",
          revision: draftPlan.latestRevisionNumber ?? null,
        });
        await captureScreenshot(
          "plan-draft",
          "Initial plan awaiting revision",
          "plan-draft.png",
        );
        await page
          .getByRole("button", {
            name: draftInteraction.payload?.rejectLabel ?? "Reject",
            exact: true,
          })
          .last()
          .click();
        const revisionComposer = page
          .getByTestId("plan-revision-composer")
          .last();
        await expect(revisionComposer).toBeVisible({ timeout: 10_000 });
        await revisionComposer
          .locator('[contenteditable="true"], textarea')
          .first()
          .fill(revisionRequest);
        await page
          .getByRole("button", {
            name: draftInteraction.payload?.rejectLabel ?? "Reject",
            exact: true,
          })
          .last()
          .click();

        const revisedState = await pollUntil({
          label: `revised plan confirmation for issue ${issue.id}`,
          deadlineAt,
          load: loadTaskState,
          accept: ({ taskRuns, interactions }) =>
            taskRuns.length >= 2 &&
            taskRuns.every((run) => TERMINAL_RUN_STATUSES.has(run.status)) &&
            interactions.some(
              (interaction) =>
                isPendingPlanConfirmation(interaction) &&
                interaction.id !== draftInteraction.id,
            ),
          reject: ({ taskRuns, interactions }) =>
            rejectPlanConfirmationPoll({
              taskRuns,
              interactions,
              minimumRunCount: 2,
            }),
        });
        const revisedInteraction = revisedState.interactions.find(
          (interaction) =>
            isPendingPlanConfirmation(interaction) &&
            interaction.id !== draftInteraction.id,
        )!;
        const revisedPlan = await api.get<IssueDocumentRecord>(
          `/api/issues/${issue.id}/documents/plan`,
        );
        const normalizedRevisedPlan = normalizePlanMarkdown(revisedPlan.body);
        if (
          !normalizedRevisedPlan.includes(planMarkers.revised) ||
          normalizedRevisedPlan.includes(planMarkers.draft)
        ) {
          throw new Error(
            `Revised Plan must replace ${planMarkers.draft} with ${planMarkers.revised}`,
          );
        }
        if (numberedPlanStepCount(revisedPlan.body) !== 3) {
          throw new Error(
            "Revised Plan must contain exactly three numbered steps",
          );
        }
        if (
          revisedInteraction.payload?.target?.revisionId !==
            revisedPlan.latestRevisionId ||
          revisedPlan.latestRevisionId === draftPlan.latestRevisionId
        ) {
          throw new Error(
            "Revised confirmation did not target a new latest Plan revision",
          );
        }
        await page.goto(
          `/${encodeURIComponent(issuePrefix)}/issues/${encodeURIComponent(issue.identifier ?? issue.id)}`,
          { waitUntil: "domcontentloaded" },
        );
        await expectPlanStageVisible(page, {
          native: execution.profile.expectedRuntimeMode === "native",
          revision: revisedPlan.latestRevisionNumber ?? null,
        });
        await captureScreenshot(
          "plan-revised",
          "Revised plan awaiting acceptance",
          "plan-revised.png",
        );
        await page
          .getByRole("button", {
            name: revisedInteraction.payload?.acceptLabel ?? "Approve",
            exact: true,
          })
          .last()
          .click();
        planLifecycleEvidence = {
          draftInteraction,
          draftPlan,
          revisedInteraction,
          revisedPlan,
          revisionRequest,
        };
      } else if (execution.task.flow === "question_resume_completion") {
        const expectedAnswer = execution.task.buildQuestionAnswer?.(nonce);
        if (!expectedAnswer) {
          throw new Error(
            `Question fixture ${execution.task.id} is missing its answer factory`,
          );
        }
        const pendingState = await pollUntil({
          label: `pending user question for issue ${issue.id}`,
          deadlineAt,
          load: loadTaskState,
          accept: ({ taskRuns, interactions }) =>
            taskRuns.length >= 1 &&
            taskRuns.every((run) => TERMINAL_RUN_STATUSES.has(run.status)) &&
            interactions.some(isPendingQuestion),
          reject: ({ taskRuns }) => definitiveRunFailure(taskRuns),
        });
        const questionInteractions = pendingState.interactions.filter(
          (interaction) => interaction.kind === "ask_user_questions",
        );
        if (
          questionInteractions.length !== 1 ||
          !isPendingQuestion(questionInteractions[0]!)
        ) {
          throw new Error(
            `Expected exactly one pending question interaction; observed ${JSON.stringify(questionInteractions)}`,
          );
        }
        const questionInteraction = questionInteractions[0]!;
        const questions = questionInteraction.payload?.questions ?? [];
        if (questionInteraction.payload?.version !== 1) {
          throw new Error("Question interaction omitted payload version 1");
        }
        if (questions.length !== 1) {
          throw new Error(
            `Expected exactly one question; observed ${questions.length}`,
          );
        }
        const question = questions[0]!;
        if (
          question.id !== "verification-word" ||
          question.prompt !== "Choose the verification word." ||
          question.selectionMode !== "single" ||
          question.required !== true ||
          JSON.stringify(question.options) !==
            JSON.stringify([
              { id: "cobalt", label: "Cobalt" },
              { id: "amber", label: "Amber" },
            ])
        ) {
          throw new Error(
            `Question interaction did not preserve the exact verification contract: ${JSON.stringify(question)}`,
          );
        }
        const selectedOption = question.options.find(
          (option) => option.label === expectedAnswer.optionLabel,
        );
        if (!selectedOption) {
          throw new Error(
            `Question interaction omitted ${expectedAnswer.optionLabel}`,
          );
        }
        expectedQuestionResolution = {
          interactionId: questionInteraction.id,
          optionId: selectedOption.id,
        };
        await page.goto(
          `/${encodeURIComponent(issuePrefix)}/issues/${encodeURIComponent(issue.identifier ?? issue.id)}`,
          { waitUntil: "domcontentloaded" },
        );
        await expect(
          page
            .getByRole("radio", {
              name: expectedAnswer.optionLabel,
              exact: true,
            })
            .last(),
        ).toBeVisible({ timeout: 30_000 });
        await captureScreenshot(
          "question-pending",
          "Structured question awaiting an answer",
          "question-pending.png",
        );
        if (execution.task.restartServerBeforeQuestionAnswer) {
          const restartRequestId = `question-wait-${nonce}`;
          await restartIsolatedPaperclipServer({
            api,
            requestId: restartRequestId,
            deadlineAt,
          });
          const documentSentinel = `__paperclip_runner_restart_${nonce.replaceAll("-", "_")}`;
          await page.evaluate(
            (key) => Reflect.set(window, key, true),
            documentSentinel,
          );
          try {
            await page.goto(
              `/${encodeURIComponent(issuePrefix)}/issues/${encodeURIComponent(issue.identifier ?? issue.id)}`,
              // The replacement Vite server can commit and render a fresh
              // document while its navigation lifecycle remains unsettled.
              // The sentinel and explicit assertions below prove the new
              // document and durable state even when Playwright times out.
              { waitUntil: "commit" },
            );
          } catch (error) {
            if (!(error instanceof Error) || error.name !== "TimeoutError") {
              throw error;
            }
          }
          await expect(
            page
              .getByRole("radio", {
                name: expectedAnswer.optionLabel,
                exact: true,
              })
              .last(),
          ).toBeVisible({ timeout: 30_000 });
          expect(
            await page.evaluate(
              (key) => Reflect.get(window, key) === true,
              documentSentinel,
            ),
          ).toBe(false);
          const reloadedInteractions = await api.get<InteractionRecord[]>(
            `/api/issues/${issue.id}/interactions`,
          );
          const reloadedQuestions = reloadedInteractions.filter(
            (interaction) => interaction.kind === "ask_user_questions",
          );
          if (
            reloadedQuestions.length !== 1 ||
            reloadedQuestions[0]?.id !== questionInteraction.id ||
            !isPendingQuestion(reloadedQuestions[0])
          ) {
            throw new Error(
              `Server restart did not preserve the exact pending interaction ${questionInteraction.id}: ${JSON.stringify(reloadedQuestions)}`,
            );
          }
          await captureScreenshot(
            "question-pending-after-server-restart",
            "Structured question preserved across server restart",
            "question-pending-after-server-restart.png",
          );
        }
        await page
          .getByRole("radio", {
            name: expectedAnswer.optionLabel,
            exact: true,
          })
          .last()
          .check();
        // Required single-select questions submit as soon as the radio is
        // checked; waiting for the multi-answer submit control would race the
        // successful continuation and misreport it as a UI failure.
        questionLifecycleEvidence = {
          interaction: questionInteraction,
          answer: expectedAnswer.optionLabel,
          expectedMarker: expectedAnswer.expectedMarker,
          serverRestartedBeforeAnswer:
            execution.task.restartServerBeforeQuestionAnswer ?? false,
        };
      } else if (execution.task.flow === "plan_approval_completion") {
        const planMarkers = execution.task.buildPlanMarkers?.(nonce);
        if (!planMarkers) {
          throw new Error(
            `Plan fixture ${execution.task.id} is missing its marker factory`,
          );
        }
        const pendingState = await pollUntil({
          label: `pending plan approval for issue ${issue.id}`,
          deadlineAt,
          load: loadTaskState,
          accept: ({ taskRuns, interactions }) =>
            taskRuns.length >= 1 &&
            taskRuns.every((run) => TERMINAL_RUN_STATUSES.has(run.status)) &&
            interactions.some(isPendingPlanConfirmation),
          reject: ({ taskRuns, interactions }) =>
            rejectPlanConfirmationPoll({
              taskRuns,
              interactions,
              minimumRunCount: 1,
            }),
        });
        const interaction = pendingState.interactions.find(
          isPendingPlanConfirmation,
        )!;
        const plan = await api.get<IssueDocumentRecord>(
          `/api/issues/${issue.id}/documents/plan`,
        );
        if (!normalizePlanMarkdown(plan.body).includes(planMarkers.draft)) {
          throw new Error(`Plan document did not contain ${planMarkers.draft}`);
        }
        if (numberedPlanStepCount(plan.body) !== 2) {
          throw new Error("Plan must contain exactly two numbered steps");
        }
        if (interaction.payload?.target?.revisionId !== plan.latestRevisionId) {
          throw new Error(
            "Plan confirmation did not target the latest Plan revision",
          );
        }
        await page.goto(
          `/${encodeURIComponent(issuePrefix)}/issues/${encodeURIComponent(issue.identifier ?? issue.id)}`,
          { waitUntil: "domcontentloaded" },
        );
        await expectPlanStageVisible(page, {
          native: execution.profile.expectedRuntimeMode === "native",
          revision: plan.latestRevisionNumber ?? null,
        });
        await captureScreenshot(
          "plan-pending",
          "Plan awaiting approval",
          "plan-pending.png",
        );
        await page
          .getByRole("button", {
            name: interaction.payload?.acceptLabel ?? "Approve",
            exact: true,
          })
          .last()
          .click();
        planLifecycleEvidence = { interaction, plan };
      }

      const taskMatchers = execution.task.buildMatchers(nonce, execution);
      let terminal = await pollUntil({
        label: `issue ${issue.id} and heartbeat run terminal state`,
        deadlineAt,
        load: loadTaskState,
        accept: ({ currentIssue, taskRuns }) =>
          currentIssue.status === execution.task.expectedTerminalState.issue &&
          taskRuns.length >= execution.task.expectedRunCount &&
          taskRuns.every((run) => TERMINAL_RUN_STATUSES.has(run.status)),
        reject: ({ taskRuns }) => definitiveRunFailure(taskRuns),
      });

      // Finalization commits the issue/run decision before the derived agent
      // comment is guaranteed to be visible through the comments endpoint.
      // Give that projection a short consistency window so a successful
      // terminal response is not misclassified as an empty provider reply.
      // If no comment arrives, retain the original terminal observation and
      // let the ordinary message matcher report the product failure.
      if (taskMatchers.some((matcher) => matcher.kind.startsWith("message_"))) {
        terminal = await pollUntil({
          label: `final agent comment for issue ${issue.id}`,
          deadlineAt: Math.min(deadlineAt, Date.now() + 30_000),
          load: loadTaskState,
          accept: ({ taskRuns, comments }) => {
            if (taskRuns.length !== execution.task.expectedRunCount) {
              return false;
            }
            const finalRun = sortRunsChronologically(taskRuns).at(-1);
            return comments.some(
              (comment) =>
                comment.createdByRunId === finalRun?.id &&
                comment.authorAgentId === fixtures!.agent.id,
            );
          },
          reject: ({ taskRuns }) => definitiveRunFailure(taskRuns),
        }).catch(() => terminal);
      }

      issue = terminal.currentIssue;
      selectedRuns = terminal.taskRuns;
      if (selectedRuns.length !== execution.task.expectedRunCount) {
        const runLogs = await Promise.all(
          selectedRuns.map(async (candidate) => ({
            runId: candidate.id,
            log: await api
              .get<unknown>(
                `/api/heartbeat-runs/${candidate.id}/log?limitBytes=1048576`,
              )
              .catch((error) => ({
                evidenceCaptureError:
                  error instanceof Error ? error.message : String(error),
              })),
          })),
        );
        await writeSanitizedJson(
          snapshotsDir,
          "api-state.json",
          { issue, runs: selectedRuns, runLogs, ...terminal },
          secrets,
        );
        throw new Error(
          `Expected exactly ${execution.task.expectedRunCount} task heartbeat run(s); observed ${selectedRuns.length}`,
        );
      }
      // The company run-list endpoint intentionally returns only a compact,
      // allowlisted context summary. Hydrate each selected run through the
      // public detail endpoint before asserting environment/lease metadata.
      selectedRuns = await Promise.all(
        selectedRuns.map((candidate) =>
          api.get<RunRecord>(`/api/heartbeat-runs/${candidate.id}`),
        ),
      );
      selectedRuns = sortRunsChronologically(selectedRuns);
      const finalRun = selectedRuns.at(-1)!;
      const run =
        selectedRuns.find(
          (candidate) => candidate.id === issue!.executionRunId,
        ) ?? selectedRuns[0];
      const [
        persistedAgentValue,
        persistedEnvironmentValue,
        runLogs,
        runEventsByRun,
      ] = await Promise.all([
        api.get<unknown>(`/api/agents/${fixtures.agent.id}`),
        api.get<unknown>(`/api/environments/${fixtures.environment.id}`),
        Promise.all(
          selectedRuns.map(async (candidate) => ({
            runId: candidate.id,
            log: await api
              .get<unknown>(
                `/api/heartbeat-runs/${candidate.id}/log?limitBytes=1048576`,
              )
              .catch((error) => ({
                evidenceCaptureError:
                  error instanceof Error ? error.message : String(error),
              })),
          })),
        ),
        Promise.all(
          selectedRuns.map(async (candidate) => {
            try {
              return {
                runId: candidate.id,
                events: await api.get<RunEventRecord[]>(
                  `/api/heartbeat-runs/${candidate.id}/events?limit=1000`,
                ),
                error: null,
              };
            } catch (error) {
              return {
                runId: candidate.id,
                events: [] as RunEventRecord[],
                error: error instanceof Error ? error.message : String(error),
              };
            }
          }),
        ),
      ]);
      const runLog =
        runLogs.find((candidate) => candidate.runId === run.id)?.log ?? {};
      const persistedAgent = record(persistedAgentValue);
      const persistedEnvironment = record(persistedEnvironmentValue);
      const agentComments = terminal.comments.filter(
        (comment) =>
          comment.authorAgentId === fixtures!.agent.id ||
          selectedRuns.some(
            (candidate) => comment.createdByRunId === candidate.id,
          ),
      );
      // Message matchers intentionally use persisted agent comments only.
      // A semantic finish summary can differ from the actual user-facing text;
      // accepting it here would let backend metadata mask a truncated UI
      // response. The browser assertion below remains the visible source of
      // truth after the comment projection has settled.
      const message = agentComments
        .map((comment) => comment.body ?? "")
        .join("\n");
      const finalRunMessage = agentComments
        .filter((comment) => comment.createdByRunId === finalRun.id)
        .map((comment) => comment.body ?? "")
        .join("\n");
      const pendingInteractions = terminal.interactions.filter(
        (interaction) => interaction.status === "pending",
      );
      const invariantFailures: string[] = [];
      if (pendingInteractions.length > 0)
        invariantFailures.push(
          `expected no unresolved interaction; observed ${pendingInteractions.length}`,
        );
      if (expectedQuestionResolution) {
        const questionInteractions = terminal.interactions.filter(
          (interaction) => interaction.kind === "ask_user_questions",
        );
        if (
          questionInteractions.length !== 1 ||
          questionInteractions[0]?.id !==
            expectedQuestionResolution.interactionId
        ) {
          invariantFailures.push(
            `expected exactly one stable question interaction ${expectedQuestionResolution.interactionId}; observed ${JSON.stringify(questionInteractions)}`,
          );
        }
        const resolvedQuestion = questionInteractions.find(
          (interaction) =>
            interaction.id === expectedQuestionResolution.interactionId,
        );
        const answers = resolvedQuestion?.result?.answers ?? [];
        if (
          resolvedQuestion?.status !== "answered" ||
          resolvedQuestion.result?.version !== 1 ||
          answers.length !== 1 ||
          answers[0]?.questionId !== "verification-word" ||
          JSON.stringify(answers[0]?.optionIds) !==
            JSON.stringify([expectedQuestionResolution.optionId]) ||
          answers[0]?.otherText !== undefined
        ) {
          invariantFailures.push(
            `expected interaction ${expectedQuestionResolution.interactionId} to resolve with exactly ${expectedQuestionResolution.optionId}; observed ${JSON.stringify(resolvedQuestion)}`,
          );
        }
        const continuationRun = selectedRuns.at(-1);
        const continuationContext = record(continuationRun?.contextSnapshot);
        if (
          !continuationRun ||
          continuationContext.interactionId !==
            expectedQuestionResolution.interactionId
        ) {
          invariantFailures.push(
            `expected the continuation run to consume interaction ${expectedQuestionResolution.interactionId}; observed ${String(continuationContext.interactionId)}`,
          );
        }
        if (execution.profile.generation === "native" && continuationRun) {
          const runnerProfile = record(continuationRun.runnerProfileJson);
          const nativeExecutionInput = record(
            runnerProfile.nativeExecutionInput,
          );
          const interactionResponses = Array.isArray(
            nativeExecutionInput.interactionResponses,
          )
            ? nativeExecutionInput.interactionResponses.map(record)
            : [];
          const matchingResponses = interactionResponses.filter(
            (candidate) =>
              candidate.interactionId ===
              expectedQuestionResolution.interactionId,
          );
          const responseEnvelope = matchingResponses[0];
          const response = record(responseEnvelope?.response);
          const responseResult = record(response.result);
          const responseAnswers = Array.isArray(responseResult.answers)
            ? responseResult.answers.map(record)
            : [];
          if (
            matchingResponses.length !== 1 ||
            responseEnvelope?.kind !== "ask_user_questions" ||
            response.status !== "answered" ||
            responseResult.version !== 1 ||
            responseAnswers.length !== 1 ||
            responseAnswers[0]?.questionId !== "verification-word" ||
            JSON.stringify(responseAnswers[0]?.optionIds) !==
              JSON.stringify([expectedQuestionResolution.optionId])
          ) {
            invariantFailures.push(
              `expected native continuation input to carry exactly one answered interaction ${expectedQuestionResolution.interactionId}; observed ${JSON.stringify(matchingResponses)}`,
            );
          }
        }
        questionLifecycleEvidence = {
          ...(questionLifecycleEvidence ?? {}),
          resolvedInteraction: resolvedQuestion ?? null,
          continuationRunId: continuationRun?.id ?? null,
        };
      }
      for (const candidate of selectedRuns) {
        if (
          (candidate.continuationAttempt ?? 0) !== 0 ||
          candidate.retryOfRunId
        )
          invariantFailures.push(
            `expected run ${candidate.id} without a recovery continuation`,
          );
      }
      for (const captured of runEventsByRun) {
        if (captured.error) {
          invariantFailures.push(
            `run ${captured.runId} events query failed: ${captured.error}`,
          );
        }
      }

      const context = record(run.contextSnapshot);
      const environmentContext = record(context.paperclipEnvironment);
      const workspaceContext = record(context.paperclipWorkspace);
      const environmentDriver =
        environmentContext.driver ?? persistedEnvironment.driver;
      const observedEnvironment =
        environmentDriver === "sandbox" ? "daytona" : environmentDriver;
      const observedRuntimeMode =
        run.runtimeMode ??
        (persistedAgent.adapterType === "paperclip_runner"
          ? "native"
          : "legacy");
      const matcherObservation = {
        message,
        issueStatus: issue.status,
        runStatus: selectedRuns.every(
          (candidate) =>
            candidate.status === execution.task.expectedTerminalState.run,
        )
          ? execution.task.expectedTerminalState.run
          : selectedRuns.map((candidate) => candidate.status).join(","),
        runtimeMode: observedRuntimeMode,
        environment:
          typeof observedEnvironment === "string"
            ? observedEnvironment
            : undefined,
        json: {
          issue,
          run,
          comments: terminal.comments,
          interactions: terminal.interactions,
        },
      };
      matcherResults = await Promise.all(
        taskMatchers.map((matcher) =>
          evaluateMatcher(matcher, {
            ...matcherObservation,
            // Multi-run tasks intentionally retain earlier waiting/revision
            // replies. Exact completion text belongs to the chronological
            // final run, while occurrence checks still span every agent
            // comment so duplicate terminal markers cannot be hidden.
            message:
              matcher.kind === "message_exact" ? finalRunMessage : message,
          }),
        ),
      );
      const failedMatchers = matcherResults.filter((result) => !result.passed);
      const exactMessageMatcher = taskMatchers.find(
        (matcher) => matcher.kind === "message_exact",
      );
      if (
        execution.profile.id === "runner-opencode" &&
        execution.task.id === "structured-question-restart-resume" &&
        exactMessageMatcher?.kind === "message_exact" &&
        finalRunMessage === exactMessageMatcher.expected.replace(/-\d+$/, "") &&
        record(finalRun.resultJson).summary === exactMessageMatcher.expected
      ) {
        // OpenCode can occasionally copy the complete marker into the
        // accepted semantic result while dropping only the synthetic attempt
        // suffix from its visible answer. Keep exact matching strict, but let
        // the campaign retry this narrowly proven provider variance once in a
        // fresh harness. A repeated near miss remains a failed cell.
        failureClassOverride = "provider_variance";
      }
      const retryInteractiveTerminalProviderVariance =
        (execution.suite.id === "openrouter-model-breadth" &&
          (execution.task.id === "question-resume-complete" ||
            execution.task.id === "plan-approve-complete")) ||
        (execution.suite.id === "core-compatibility" &&
          execution.profile.generation === "native" &&
          execution.task.id === "plan-revise-accept");
      if (
        retryInteractiveTerminalProviderVariance &&
        exactMessageMatcher?.kind === "message_exact" &&
        selectedRuns.every((candidate) => candidate.status === "succeeded") &&
        issue.status === "done" &&
        finalRunMessage !== exactMessageMatcher.expected &&
        record(finalRun.resultJson).summary === exactMessageMatcher.expected
      ) {
        // An interactive breadth model can occasionally satisfy the durable
        // terminal contract while paraphrasing the visible final response.
        // Preserve the exact persisted-message and DOM assertions, but
        // classify this narrowly proven provider variance for one
        // fresh-harness retry.
        failureClassOverride = "provider_variance";
      }
      const observedEnvironmentId =
        environmentContext.id ??
        (execution.environment.id === "local"
          ? persistedAgent.defaultEnvironmentId
          : undefined);
      if (observedEnvironmentId !== fixtures.environment.id) {
        invariantFailures.push(
          `Expected environment ${fixtures.environment.id}; observed ${String(observedEnvironmentId)}`,
        );
      }
      if (
        execution.environment.id === "daytona" &&
        typeof environmentContext.leaseId !== "string"
      ) {
        invariantFailures.push(
          "expected a Daytona sandbox lease on the run context",
        );
      }
      if (execution.environment.id === "local") {
        const runLogContent = String(record(runLog).content ?? "");
        // The log endpoint returns NDJSON, so quotes inside each `chunk` are
        // escaped. Accept both that wire representation and a decoded chunk.
        const fallbackWorkspace =
          /Using fallback workspace \\\"([^"\\]+)\\\"/.exec(
            runLogContent,
          )?.[1] ??
          /Using fallback workspace "([^"]+)"/.exec(runLogContent)?.[1];
        const cwd = String(workspaceContext.cwd ?? fallbackWorkspace ?? "");
        if (!cwd.startsWith(`${temporaryRoot}/`)) {
          invariantFailures.push(
            `local run workspace escaped the isolated root: ${cwd}`,
          );
        }
      }
      const runEvents =
        runEventsByRun.find((candidate) => candidate.runId === run.id)
          ?.events ?? [];
      if (execution.profile.generation === "native") {
        for (const candidate of selectedRuns) {
          const candidateEvents =
            runEventsByRun.find((captured) => captured.runId === candidate.id)
              ?.events ?? [];
          const runnerInstanceObserved =
            Boolean(candidate.runnerInstanceId) ||
            candidateEvents.some(
              (event) =>
                typeof event.sourceInstanceId === "string" &&
                event.sourceInstanceId.length > 0 &&
                !event.sourceInstanceId.endsWith(":control"),
            );
          if (!runnerInstanceObserved) {
            invariantFailures.push(
              `expected native run ${candidate.id} events from a runner instance`,
            );
          }
          invariantFailures.push(
            ...nativeRunEventIntegrityFailures(candidate, candidateEvents),
          );
        }
        if (
          (execution.profile.provider === "codex" ||
            execution.profile.provider === "opencode") &&
          selectedRuns.length > 1
        ) {
          invariantFailures.push(
            ...providerSessionContinuityFailures(
              execution.profile.provider,
              selectedRuns,
            ),
          );
        } else if (
          execution.profile.provider === "acpx" &&
          selectedRuns.length > 1
        ) {
          for (let index = 1; index < selectedRuns.length; index += 1) {
            const previousSessionId = selectedRuns[index - 1]?.sessionIdAfter;
            const current = selectedRuns[index]!;
            const currentSessionId = current.sessionIdAfter;
            if (!previousSessionId || !currentSessionId) {
              invariantFailures.push(
                "expected ACPX to record provider session identity across all heartbeat runs",
              );
              continue;
            }
            const acceptedPlanResetFailures = acceptedPlanSessionResetFailures(
              "acpx",
              previousSessionId,
              current,
            );
            if (acceptedPlanResetFailures) {
              invariantFailures.push(...acceptedPlanResetFailures);
              continue;
            }
            if (previousSessionId === currentSessionId) continue;
            const currentEvents =
              runEventsByRun.find((captured) => captured.runId === current.id)
                ?.events ?? [];
            const recordedContinuityBreak = currentEvents.some((event) => {
              const payload = record(event.payload);
              return (
                event.eventType === "run.performance.span" &&
                payload.span === "provider.session.continuity_break" &&
                payload.previousProviderSessionId === previousSessionId &&
                payload.replacementProviderSessionId === currentSessionId
              );
            });
            if (!recordedContinuityBreak) {
              invariantFailures.push(
                `ACPX provider session changed from ${previousSessionId} to ${currentSessionId} without a matching continuity event`,
              );
            }
          }
        }
        const spanPayloads = runEvents
          .filter((event) => event.eventType === "run.performance.span")
          .map((event) => record(event.payload));
        const selectedTransport = spanPayloads.find(
          (payload) => payload.span === "runner.transport.selected",
        );
        const expectedTransport =
          execution.environment.id === "daytona"
            ? "provider_ingress"
            : "local_loopback";
        if (selectedTransport?.mode !== expectedTransport) {
          invariantFailures.push(
            `Expected native runner transport ${expectedTransport}; observed ${String(selectedTransport?.mode)}`,
          );
        }
        if (execution.environment.id === "daytona") {
          const authenticated = spanPayloads.some(
            (event) =>
              event.span === "runner.prp.authenticate" &&
              event.outcome === "ok",
          );
          if (!authenticated) {
            invariantFailures.push(
              "expected authenticated native Daytona runner preview ingress",
            );
          }
        }
      } else {
        for (const candidate of selectedRuns) {
          const candidateEvents =
            runEventsByRun.find((captured) => captured.runId === candidate.id)
              ?.events ?? [];
          if (
            candidate.runtimeMode !== "legacy" ||
            candidate.runnerInstanceId ||
            candidateEvents.some(
              (event) =>
                Object.keys(record(event.payload?.prpEvent)).length > 0,
            )
          ) {
            invariantFailures.push(
              `legacy run ${candidate.id} crossed into native runner persistence`,
            );
          }
        }
      }

      await writeSanitizedJson(
        snapshotsDir,
        "api-state.json",
        {
          issue,
          run,
          comments: terminal.comments,
          interactions: terminal.interactions,
          planLifecycleEvidence,
          questionLifecycleEvidence,
          matcherResults,
          invariantFailures,
          runEvents,
          runEventsByRun,
          runLogs,
        },
        secrets,
      );

      if (
        exactMessageMatcher?.kind === "message_exact" &&
        isOpenRouterDeepSeekHelloTerminalVariance({
          suiteId: execution.suite.id,
          profileId: execution.profile.id,
          taskId: execution.task.id,
          expectedMarker: exactMessageMatcher.expected,
          finalRunMessage,
          allAgentMessages: message,
          semanticSummary: record(finalRun.resultJson).summary,
          issueStatus: issue.status,
          runStatuses: selectedRuns.map((candidate) => candidate.status),
          matcherResults,
          invariantFailures,
        })
      ) {
        // DeepSeek can occasionally complete the semantic finish correctly but
        // expose its pre-tool acknowledgement as the visible final answer. Keep
        // exact persisted-message, global occurrence, and DOM checks strict,
        // while allowing one fresh-harness retry only for the zero-marker form.
        failureClassOverride = "provider_variance";
      }

      // The backend polling above can observe a terminal transition before a
      // websocket invalidation reaches the already-open task page. Reload the
      // canonical task route so the screenshot and UI assertions prove the
      // persisted final state, not a stale client cache.
      await page.goto(
        `/${encodeURIComponent(issuePrefix)}/issues/${encodeURIComponent(issue.identifier ?? issue.id)}`,
        { waitUntil: "domcontentloaded" },
      );
      const visibleAgentReplies = page
        .getByTestId("task-chat-thread")
        .getByTestId("task-chat-agent-bubble");
      const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const terminalAgentReplies = visibleAgentReplies.filter({
        hasText: new RegExp(`^\\s*${escapedMarker}\\s*$`),
      });
      await expect(terminalAgentReplies).toHaveCount(1, { timeout: 30_000 });
      await expect(terminalAgentReplies.first()).toBeVisible();
      // A string-valued toHaveText assertion compares the complete rendered
      // text while normalizing ordinary DOM whitespace. This keeps Markdown
      // layout differences harmless without allowing prefixed, suffixed, or
      // substituted provider prose to masquerade as the requested response.
      await expect(terminalAgentReplies.first()).toHaveText(marker, {
        useInnerText: true,
      });
      await expect(
        page.getByTestId("issue-detail-header").getByRole("button", {
          name: "Change status (current: Done)",
          exact: true,
        }),
      ).toBeVisible({ timeout: 30_000 });
      await captureScreenshot(
        "final-state",
        "Final visible task state",
        "final-state.png",
      );

      if (failedMatchers.length > 0) {
        throw new Error(
          `Matcher failure: ${failedMatchers.map((result) => result.detail).join("; ")}; run error: ${run.errorCode ?? "none"} ${run.error ?? "none"}`,
        );
      }
      if (invariantFailures.length > 0) {
        throw new Error(
          `Runtime invariant failure: ${invariantFailures.join("; ")}`,
        );
      }
    } catch (error) {
      primaryError = error;
      try {
        await captureFailureApiState();
      } catch (captureError) {
        const failureClass = classifyFailure(captureError);
        if (failureClass === "secret_leak") {
          failureClassOverride = "secret_leak";
          primaryError = new AggregateError(
            [primaryError, captureError],
            `Failure evidence contained unsafe data: ${captureError instanceof Error ? captureError.message : String(captureError)}`,
          );
        } else {
          networkDiagnostics.push({
            evidenceCaptureError:
              captureError instanceof Error
                ? captureError.message
                : String(captureError),
          });
        }
      }
      if (!page.isClosed()) {
        if (isReviewedFixtureScreenshotRoute()) {
          await captureScreenshot(
            "failure",
            "Task state at failure",
            "failure.png",
          ).catch(() => undefined);
        } else {
          await capturePrivateScreenshot("failure", "failure.png").catch(
            () => undefined,
          );
        }
      }
    } finally {
      try {
        await writeSanitizedJson(
          snapshotsDir,
          "browser-diagnostics.json",
          {
            console: consoleDiagnostics,
            network: networkDiagnostics,
          },
          secrets,
        );
      } catch (error) {
        primaryError = new AggregateError(
          [primaryError, error].filter(Boolean),
          `Browser diagnostics contained unsafe data: ${error instanceof Error ? error.message : String(error)}`,
        );
        failureClassOverride = "secret_leak";
      }
      if (fixtures) {
        await captureRuntimeLeases().catch((error) => {
          networkDiagnostics.push({
            runtimeBillingCaptureError:
              error instanceof Error ? error.message : String(error),
          });
        });
        try {
          await fixtures.teardown();
          cleanup = "passed";
        } catch (error) {
          cleanup = "failed";
          const priorFailureClass = primaryError
            ? classifyFailure(primaryError)
            : undefined;
          const cleanupFailureClass = classifyFailure(error);
          failureClassOverride =
            priorFailureClass === "secret_leak"
              ? priorFailureClass
              : cleanupFailureClass === "cleanup_failure"
                ? cleanupFailureClass
                : (priorFailureClass ?? cleanupFailureClass);
          primaryError = new AggregateError(
            [primaryError, error].filter(Boolean),
            `Cleanup failed after ${primaryError ? "test failure" : "test execution"}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (runtimeLeases.length > 0) {
          runtimeLeases = await Promise.all(
            runtimeLeases.map((lease) =>
              api
                .get<EnvironmentLeaseRecord>(
                  `/api/environment-leases/${lease.id}`,
                )
                .catch(() => lease),
            ),
          );
        }
      } else {
        cleanup =
          primaryError &&
          /(?:cleanup|teardown) failed/i.test(
            primaryError instanceof Error
              ? primaryError.message
              : String(primaryError),
          )
            ? "failed"
            : "passed";
      }

      const finishedAtMs = Date.now();
      const runtimeUsage = buildRuntimeUsage({
        environmentId: execution.environment.id,
        runs: selectedRuns,
        leases: runtimeLeases,
        fallbackFinishedAt: new Date(finishedAtMs),
      });
      const resultWithoutBilling: RunnerE2EResult = {
        schema: "paperclip.runner-e2e.result/v2",
        executionId: execution.id,
        suiteId: execution.suite.id,
        suiteDefinitionHash: execution.suiteDefinitionHash,
        source: resolveRunnerE2ESource(),
        ...(execution.profile.ranking
          ? { rankingSnapshot: execution.profile.ranking }
          : {}),
        attempt,
        status: primaryError ? "failed" : "passed",
        ...(primaryError
          ? {
              failureClass:
                failureClassOverride ?? classifyFailure(primaryError),
              error:
                primaryError instanceof Error
                  ? primaryError.message
                  : String(primaryError),
            }
          : {}),
        profileId: execution.profile.id,
        environmentId: execution.environment.id,
        caseId: execution.task.id,
        provider: execution.profile.provider,
        model: execution.profile.model,
        runtimeMode: execution.profile.expectedRuntimeMode,
        issueId: issue?.id,
        issueIdentifier: issue?.identifier ?? null,
        runIds: selectedRuns.map((run) => run.id),
        startedAt,
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: finishedAtMs - startedAtMs,
        usage:
          selectedRuns.length === 1
            ? (selectedRuns[0]?.usageJson ?? null)
            : {
                runs: selectedRuns.map((candidate) => ({
                  runId: candidate.id,
                  usage: candidate.usageJson ?? null,
                })),
              },
        runtimeUsage,
        matcherResults,
        screenshots,
        cleanup,
      };
      const result: RunnerE2EResult = {
        ...resultWithoutBilling,
        billing: summarizeExecutionBilling(resultWithoutBilling),
      };
      await mkdir(privateDir, { recursive: true });
      await writeFile(
        resultPath,
        `${JSON.stringify(sanitizeJson(result, secrets), null, 2)}\n`,
        "utf8",
      );
      await testInfo.attach("runner-e2e-result", {
        path: resultPath,
        contentType: "application/json",
      });
    }

    if (primaryError) throw primaryError;
  });
}
